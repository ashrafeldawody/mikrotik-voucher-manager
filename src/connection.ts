/**
 * Connection — persistent, auto-reconnecting wrapper around the `routeros` client.
 *
 * Responsibilities:
 *  - Hold a single long-lived TCP connection to the router
 *  - Serialize all commands through an internal FIFO queue
 *  - Auto-reconnect with exponential backoff on socket drops
 *  - Emit connect / disconnect / reconnecting / error events
 *  - Reject in-flight commands if the socket drops mid-op (do not silently retry writes)
 */

import { EventEmitter } from 'node:events';
import type { MikrotikClientConfig, Logger, RawResponse } from './types.js';
import { mapMikrotikError, MikrotikConnectionError } from './errors.js';

// `routeros` ships untyped — keep the surface minimal.
interface RouterOsInstance {
  connect: () => Promise<unknown>;
  write: (path: string, params?: string[]) => Promise<RawResponse[]>;
  close: () => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}

interface RouterOsConstructor {
  new (options: {
    host: string;
    user: string;
    password: string;
    port?: number;
    timeout?: number;
    tls?: unknown;
  }): RouterOsInstance;
}

interface QueuedCommand {
  path: string;
  params: string[];
  resolve: (value: RawResponse[]) => void;
  reject: (error: Error) => void;
}

type RouterOsFactory = () => Promise<RouterOsConstructor>;

const defaultFactory: RouterOsFactory = async () => {
  // Dynamic import so the `routeros` module can be stubbed in unit tests via
  // dependency injection (`new Connection(config, { routerOsFactory })`).
  const mod = await import('routeros');
  const ctor = (mod as { RouterOSAPI?: RouterOsConstructor }).RouterOSAPI;
  if (!ctor) {
    throw new Error('routeros module did not export RouterOSAPI');
  }
  return ctor;
};

export interface ConnectionOptions {
  routerOsFactory?: RouterOsFactory;
}

export declare interface Connection {
  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: (reason: string) => void): this;
  on(event: 'reconnecting', listener: (attempt: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: 'connect'): boolean;
  emit(event: 'disconnect', reason: string): boolean;
  emit(event: 'reconnecting', attempt: number): boolean;
  emit(event: 'error', error: Error): boolean;
  emit(event: string, ...args: any[]): boolean;
}

export class Connection extends EventEmitter {
  private readonly config: MikrotikClientConfig;
  private readonly logger: Logger;
  private readonly factory: RouterOsFactory;

  private api: RouterOsInstance | null = null;
  private queue: QueuedCommand[] = [];
  private processing = false;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private inFlight: QueuedCommand | null = null;

  constructor(config: MikrotikClientConfig, opts: ConnectionOptions = {}) {
    super();
    this.config = config;
    this.logger = config.logger ?? silentLogger();
    this.factory = opts.routerOsFactory ?? defaultFactory;
  }

  get isConnected(): boolean {
    return this.connected && !this.closed;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new MikrotikConnectionError('Connection is closed');
    }
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.openSocket();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openSocket(): Promise<void> {
    const Ctor = await this.factory();
    const api = new Ctor({
      host: this.config.host,
      user: this.config.username,
      password: this.config.password,
      port: this.config.port ?? 8728,
      timeout: this.config.timeout ?? 10_000,
    });

    try {
      await api.connect();
    } catch (err) {
      throw mapMikrotikError(err);
    }

    this.api = api;
    this.connected = true;
    this.emit('connect');

    // Kick the queue in case commands were enqueued while we were connecting.
    this.drain();
  }

  /**
   * Queue a command. Resolves with the response, rejects with a typed MikrotikError.
   */
  exec(path: string, params: string[] = []): Promise<RawResponse[]> {
    if (this.closed) {
      return Promise.reject(new MikrotikConnectionError('Connection is closed'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ path, params, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.processing) return;
    if (!this.isConnected) {
      // If we have queued items but aren't connected, attempt to connect.
      if (this.queue.length > 0 && !this.connecting) {
        this.connect().catch((err) => {
          // Reject every queued command if initial connect fails.
          const error = mapMikrotikError(err);
          const drained = this.queue.splice(0);
          for (const cmd of drained) cmd.reject(error);
          this.emit('error', error);
        });
      }
      return;
    }

    this.processing = true;
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    try {
      while (this.queue.length > 0 && this.isConnected) {
        const cmd = this.queue.shift()!;
        this.inFlight = cmd;
        try {
          const result = await this.api!.write(cmd.path, cmd.params);
          cmd.resolve(result);
        } catch (err) {
          const mapped = mapMikrotikError(err);
          cmd.reject(mapped);

          if (mapped instanceof MikrotikConnectionError) {
            // Socket likely dropped — close and trigger reconnect for the remaining queue.
            this.inFlight = null;
            await this.handleSocketDrop(mapped);
            return;
          }
        } finally {
          this.inFlight = null;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleSocketDrop(error: Error): Promise<void> {
    this.connected = false;
    try {
      this.api?.close();
    } catch {
      // ignore
    }
    this.api = null;
    this.emit('disconnect', error.message);

    const reconnect = this.config.reconnect ?? {};
    if (reconnect.enabled === false) {
      // Reject everything queued
      const drained = this.queue.splice(0);
      for (const cmd of drained) cmd.reject(error);
      return;
    }

    const maxAttempts = reconnect.maxAttempts ?? 5;
    const baseBackoff = reconnect.backoffMs ?? 1000;
    const maxBackoff = reconnect.maxBackoffMs ?? 30_000;

    let attempt = 0;
    while (attempt < maxAttempts && !this.closed) {
      attempt += 1;
      this.emit('reconnecting', attempt);
      const delay = Math.min(baseBackoff * Math.pow(2, attempt - 1), maxBackoff);
      await sleep(delay);

      try {
        await this.openSocket();
        // Success — resume queue processing
        this.drain();
        return;
      } catch (err) {
        this.logger.warn(`[mikrotik] reconnect attempt ${attempt}/${maxAttempts} failed:`, extractErrMsg(err));
      }
    }

    // Exhausted attempts — reject queue, emit error
    const failure = new MikrotikConnectionError(
      `Reconnect failed after ${maxAttempts} attempts`,
      error
    );
    const drained = this.queue.splice(0);
    for (const cmd of drained) cmd.reject(failure);
    this.emit('error', failure);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.connected = false;
    if (this.api) {
      try {
        this.api.close();
      } catch {
        // ignore
      }
      this.api = null;
    }
    // Reject any remaining queued commands
    const drained = this.queue.splice(0);
    const err = new MikrotikConnectionError('Connection closed by client');
    for (const cmd of drained) cmd.reject(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function silentLogger(): Logger {
  return {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
}
