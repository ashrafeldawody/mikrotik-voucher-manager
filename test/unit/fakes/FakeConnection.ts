/**
 * FakeConnection — a test double that records every exec() call and returns
 * canned responses. Used by all strategy/client unit tests so they don't
 * touch a real router or even the `routeros` module.
 */

import { EventEmitter } from 'node:events';
import type { RawResponse } from '../../../src/types.js';

export type Responder =
  | RawResponse[]
  | Error
  | ((params: string[]) => RawResponse[] | Error);

export interface RecordedCall {
  path: string;
  params: string[];
}

export class FakeConnection extends EventEmitter {
  public calls: RecordedCall[] = [];
  public isConnected = true;
  private routes = new Map<string, Responder>();
  private defaultResponse: RawResponse[] = [];
  private connectCalled = false;
  private disconnectCalled = false;

  /**
   * Register a canned response for a RouterOS path.
   * Later registrations override earlier ones.
   */
  override on(path: string, responder: Responder): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(pathOrEvent: string | symbol, responder: any): this {
    // If it's a RouterOS path (starts with /), register a responder.
    if (typeof pathOrEvent === 'string' && pathOrEvent.startsWith('/')) {
      this.routes.set(pathOrEvent, responder as Responder);
      return this;
    }
    // Otherwise, act as a normal EventEmitter.
    super.on(pathOrEvent, responder);
    return this;
  }

  respond(path: string, responder: Responder): this {
    this.routes.set(path, responder);
    return this;
  }

  setDefaultResponse(response: RawResponse[]): this {
    this.defaultResponse = response;
    return this;
  }

  async connect(): Promise<void> {
    this.connectCalled = true;
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
    this.isConnected = false;
  }

  exec(path: string, params: string[] = []): Promise<RawResponse[]> {
    this.calls.push({ path, params });

    const responder = this.routes.get(path);
    if (responder === undefined) {
      return Promise.resolve(this.defaultResponse);
    }

    if (responder instanceof Error) {
      return Promise.reject(responder);
    }

    if (typeof responder === 'function') {
      const result = responder(params);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }

    return Promise.resolve(responder);
  }

  // Introspection helpers for tests
  get wasConnected(): boolean {
    return this.connectCalled;
  }
  get wasDisconnected(): boolean {
    return this.disconnectCalled;
  }
  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path === path);
  }
  lastCallTo(path: string): RecordedCall | undefined {
    const calls = this.callsTo(path);
    return calls[calls.length - 1];
  }
  reset(): void {
    this.calls = [];
    this.routes.clear();
    this.defaultResponse = [];
  }
}
