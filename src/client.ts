/**
 * MikrotikClient — the public entry point for mikrotik-voucher-manager.
 *
 * Wraps a persistent Connection and delegates to a HotspotStrategy or
 * UserManagerStrategy based on config.mode. All sub-APIs (profiles,
 * vouchers, sessions, system, raw) expose typed operations that work
 * identically against either backend.
 */

import { EventEmitter } from 'node:events';
import type {
  MikrotikClientConfig,
  MikrotikMode,
  ConnectionTestResult,
  SystemIdentity,
  SystemResource,
  Profile,
  Voucher,
  VoucherUsage,
  ActiveSession,
  CreateProfileInput,
  UpdateProfileInput,
  CreateVoucherInput,
  VoucherFilter,
  BulkResult,
  Duration,
  RawResponse,
} from './types.js';
import { Connection, type ConnectionOptions } from './connection.js';
import type { IWifiBackend } from './strategies/interface.js';
import { HotspotStrategy } from './strategies/hotspot.js';
import { UserManagerStrategy } from './strategies/usermanager.js';
import { MikrotikValidationError, mapMikrotikError } from './errors.js';

export interface MikrotikClientOptions extends ConnectionOptions {}

export declare interface MikrotikClient {
  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: (reason: string) => void): this;
  on(event: 'reconnecting', listener: (attempt: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class MikrotikClient extends EventEmitter {
  public readonly config: MikrotikClientConfig;
  public readonly mode: MikrotikMode;
  private readonly _connection: Connection;
  private readonly backend: IWifiBackend;

  public readonly profiles: ProfilesApi;
  public readonly vouchers: VouchersApi;
  public readonly sessions: SessionsApi;
  public readonly system: SystemApi;
  public readonly raw: RawApi;

  constructor(config: MikrotikClientConfig, opts: MikrotikClientOptions = {}) {
    super();
    if (!config.host) throw new MikrotikValidationError('config.host is required');
    if (!config.username) throw new MikrotikValidationError('config.username is required');
    if (config.password == null) {
      throw new MikrotikValidationError('config.password is required (use "" for empty)');
    }

    this.config = { ...config };
    this.mode = config.mode ?? 'hotspot';

    this._connection = new Connection(this.config, opts);
    this._connection.on('connect', () => this.emit('connect'));
    this._connection.on('disconnect', (reason) => this.emit('disconnect', reason));
    this._connection.on('reconnecting', (attempt) => this.emit('reconnecting', attempt));
    this._connection.on('error', (err) => this.emit('error', err));

    if (this.mode === 'usermanager') {
      this.backend = new UserManagerStrategy(this._connection, config.customer ?? 'admin');
    } else {
      this.backend = new HotspotStrategy(this._connection);
    }

    this.profiles = new ProfilesApi(this.backend);
    this.vouchers = new VouchersApi(this.backend);
    this.sessions = new SessionsApi(this.backend);
    this.system = new SystemApi(this._connection);
    this.raw = new RawApi(this._connection);
  }

  get isConnected(): boolean {
    return this._connection.isConnected;
  }

  get connection(): Connection {
    return this._connection;
  }

  async connect(): Promise<void> {
    await this._connection.connect();
  }

  async disconnect(): Promise<void> {
    await this._connection.disconnect();
  }

  /**
   * One-shot helper: opens a client, runs the callback, always closes.
   * Renamed from `once` to avoid clashing with `EventEmitter.once`.
   */
  static async withClient<T>(
    config: MikrotikClientConfig,
    fn: (client: MikrotikClient) => Promise<T>,
    opts?: MikrotikClientOptions
  ): Promise<T> {
    const client = new MikrotikClient(config, opts);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      await client.disconnect();
    }
  }

  /**
   * Static connection test. Does NOT create a persistent client.
   */
  static async testConnection(
    config: MikrotikClientConfig,
    opts?: MikrotikClientOptions
  ): Promise<ConnectionTestResult> {
    const tester = new Connection(config, opts);
    try {
      await tester.connect();
      const identityRows = await tester.exec('/system/identity/print');
      const resourceRows = await tester.exec('/system/resource/print');
      return {
        ok: true,
        identity: identityRows[0]?.['name'] ?? 'Unknown',
        version: resourceRows[0]?.['version'] ?? 'Unknown',
      };
    } catch (err) {
      const mapped = mapMikrotikError(err);
      return { ok: false, error: mapped.message };
    } finally {
      await tester.disconnect();
    }
  }
}

// ---------- Sub-APIs ----------

class ProfilesApi {
  constructor(private readonly backend: IWifiBackend) {}

  list(): Promise<Profile[]> {
    return this.backend.listProfiles();
  }
  get(name: string): Promise<Profile | null> {
    return this.backend.getProfile(name);
  }
  create(input: CreateProfileInput): Promise<Profile> {
    return this.backend.createProfile(input);
  }
  update(name: string, patch: UpdateProfileInput): Promise<Profile> {
    return this.backend.updateProfile(name, patch);
  }
  delete(name: string): Promise<void> {
    return this.backend.deleteProfile(name);
  }
}

class VouchersApi {
  constructor(private readonly backend: IWifiBackend) {}

  create(input: CreateVoucherInput): Promise<Voucher> {
    return this.backend.createVoucher(input);
  }
  createBulk(inputs: CreateVoucherInput[]): Promise<BulkResult<Voucher, CreateVoucherInput>> {
    return this.backend.createBulkVouchers(inputs);
  }
  get(code: string): Promise<Voucher | null> {
    return this.backend.getVoucher(code);
  }
  list(filter?: VoucherFilter): Promise<Voucher[]> {
    return this.backend.listVouchers(filter);
  }
  checkUsage(code: string): Promise<VoucherUsage> {
    return this.backend.checkUsage(code);
  }
  delete(code: string): Promise<void> {
    return this.backend.deleteVoucher(code);
  }
  deleteBulk(codes: string[]): Promise<BulkResult<string, string>> {
    return this.backend.deleteBulkVouchers(codes);
  }
  enable(code: string): Promise<void> {
    return this.backend.enableVoucher(code);
  }
  disable(code: string): Promise<void> {
    return this.backend.disableVoucher(code);
  }
  resetUsage(code: string): Promise<void> {
    return this.backend.resetVoucherUsage(code);
  }
  extend(code: string, extra: Duration): Promise<void> {
    return this.backend.extendVoucher(code, extra);
  }
  changeProfile(code: string, newProfile: string): Promise<void> {
    return this.backend.changeVoucherProfile(code, newProfile);
  }
}

class SessionsApi {
  constructor(private readonly backend: IWifiBackend) {}

  list(): Promise<ActiveSession[]> {
    return this.backend.listActiveSessions();
  }
  get(username: string): Promise<ActiveSession | null> {
    return this.backend.getActiveSession(username);
  }
  kick(username: string): Promise<void> {
    return this.backend.kickSession(username);
  }
}

class SystemApi {
  constructor(private readonly connection: Connection) {}

  async identity(): Promise<SystemIdentity> {
    const rows = await this.connection.exec('/system/identity/print');
    return { name: rows[0]?.['name'] ?? 'Unknown' };
  }

  async resource(): Promise<SystemResource> {
    const rows = await this.connection.exec('/system/resource/print');
    const r = rows[0] ?? {};
    return {
      version: r['version'] ?? '',
      uptime: r['uptime'] ?? '',
      cpuLoad: parseInt(r['cpu-load'] || '0', 10) || 0,
      freeMemory: parseInt(r['free-memory'] || '0', 10) || 0,
      totalMemory: parseInt(r['total-memory'] || '0', 10) || 0,
      boardName: r['board-name'] ?? '',
      architectureName: r['architecture-name'] ?? '',
    };
  }

  async detectUserManagerVersion(): Promise<'v1' | 'v2' | 'none'> {
    try {
      await this.connection.exec('/tool/user-manager/profile/print');
      // v2 ships with /tool/user-manager/limitation (flat)
      try {
        await this.connection.exec('/tool/user-manager/limitation/print');
        return 'v2';
      } catch {
        return 'v1';
      }
    } catch {
      return 'none';
    }
  }
}

class RawApi {
  constructor(private readonly connection: Connection) {}

  exec(path: string, params: string[] = []): Promise<RawResponse[]> {
    return this.connection.exec(path, params);
  }
}
