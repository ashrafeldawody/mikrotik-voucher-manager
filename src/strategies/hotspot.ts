/**
 * HotspotStrategy — implements the IWifiBackend interface against /ip/hotspot/*.
 *
 * Hotspot is the simpler of the two backends: vouchers live in /ip/hotspot/user
 * with limits stored directly on the user record.
 */

import type {
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
} from '../types.js';
import type { Connection } from '../connection.js';
import type { IWifiBackend } from './interface.js';
import {
  parseDurationToSeconds,
  formatSecondsToDuration,
  normalizeDuration,
  parseByteSize,
  parseMikrotikDate,
  normalizeCallerId,
} from '../utils/index.js';
import {
  MikrotikNotFoundError,
  MikrotikAlreadyExistsError,
  mapMikrotikError,
} from '../errors.js';

const DEFAULT_COMMENT = 'mikrotik-voucher-manager';

export class HotspotStrategy implements IWifiBackend {
  public readonly mode = 'hotspot' as const;

  constructor(public readonly connection: Connection) {}

  // ---------- Profiles ----------

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.connection.exec('/ip/hotspot/user/profile/print');
    return rows.map((row) => this.rowToProfile(row));
  }

  async getProfile(name: string): Promise<Profile | null> {
    const rows = await this.connection.exec('/ip/hotspot/user/profile/print', [
      `?name=${name}`,
    ]);
    if (rows.length === 0) return null;
    return this.rowToProfile(rows[0]!);
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const params = [
      `=name=${input.name}`,
      `=status-autorefresh=1m`,
      `=transparent-proxy=yes`,
    ];
    if (input.rateLimit) params.push(`=rate-limit=${input.rateLimit}`);
    if (input.sharedUsers != null) params.push(`=shared-users=${input.sharedUsers}`);

    try {
      await this.connection.exec('/ip/hotspot/user/profile/add', params);
    } catch (err) {
      if (err instanceof MikrotikAlreadyExistsError) {
        // Fall through to fetch
      } else {
        throw err;
      }
    }

    const profile = await this.getProfile(input.name);
    if (!profile) {
      throw new MikrotikNotFoundError(`Profile ${input.name} not found after create`);
    }
    return profile;
  }

  async updateProfile(name: string, patch: UpdateProfileInput): Promise<Profile> {
    const existing = await this.getProfile(name);
    if (!existing) throw new MikrotikNotFoundError(`Profile ${name} not found`);

    const params = [`=.id=${existing.raw['.id']}`];
    if (patch.rateLimit !== undefined) params.push(`=rate-limit=${patch.rateLimit}`);
    if (patch.sharedUsers !== undefined) params.push(`=shared-users=${patch.sharedUsers}`);

    if (params.length > 1) {
      await this.connection.exec('/ip/hotspot/user/profile/set', params);
    }
    return (await this.getProfile(name))!;
  }

  async deleteProfile(name: string): Promise<void> {
    const existing = await this.getProfile(name);
    if (!existing) throw new MikrotikNotFoundError(`Profile ${name} not found`);
    await this.connection.exec('/ip/hotspot/user/profile/remove', [
      `=.id=${existing.raw['.id']}`,
    ]);
  }

  // ---------- Vouchers ----------

  async createVoucher(input: CreateVoucherInput): Promise<Voucher> {
    const params = [
      `=name=${input.code}`,
      `=profile=${input.profile}`,
      `=comment=${input.comment ?? DEFAULT_COMMENT}`,
    ];

    if (input.password) params.push(`=password=${input.password}`);
    if (input.validity !== undefined) {
      params.push(`=limit-uptime=${normalizeDuration(input.validity)}`);
    }
    if (input.dataLimit !== undefined) {
      const bytes = parseByteSize(input.dataLimit);
      if (bytes > 0) params.push(`=limit-bytes-total=${bytes}`);
    }

    await this.connection.exec('/ip/hotspot/user/add', params);
    const voucher = await this.getVoucher(input.code);
    if (!voucher) {
      throw new MikrotikNotFoundError(`Voucher ${input.code} not found after create`);
    }
    return voucher;
  }

  async createBulkVouchers(
    inputs: CreateVoucherInput[]
  ): Promise<BulkResult<Voucher, CreateVoucherInput>> {
    const result: BulkResult<Voucher, CreateVoucherInput> = {
      total: inputs.length,
      succeeded: [],
      failed: [],
    };
    for (const input of inputs) {
      try {
        const v = await this.createVoucher(input);
        result.succeeded.push(v);
      } catch (err) {
        result.failed.push({ input, error: mapMikrotikError(err) });
      }
    }
    return result;
  }

  async getVoucher(code: string): Promise<Voucher | null> {
    const rows = await this.connection.exec('/ip/hotspot/user/print', [
      `?name=${code}`,
    ]);
    if (rows.length === 0) return null;
    return this.rowToVoucher(rows[0]!);
  }

  async listVouchers(filter: VoucherFilter = {}): Promise<Voucher[]> {
    const params: string[] = [];
    if (filter.profile) params.push(`?profile=${filter.profile}`);
    if (filter.disabled !== undefined) {
      params.push(`?disabled=${filter.disabled ? 'true' : 'false'}`);
    }

    const rows = await this.connection.exec('/ip/hotspot/user/print', params);

    let vouchers = rows.map((r) => this.rowToVoucher(r));

    if (filter.commentPrefix) {
      vouchers = vouchers.filter((v) => v.comment.startsWith(filter.commentPrefix!));
    }
    if (filter.used !== undefined) {
      vouchers = vouchers.filter((v) => (v.usage.bytesTotal > 0) === filter.used);
    }

    if (filter.active !== undefined || filter.active === true) {
      // Fetch active sessions once and filter in JS
      const activeRows = await this.connection.exec('/ip/hotspot/active/print');
      const activeSet = new Set(activeRows.map((r) => r['user']));
      vouchers = vouchers.filter((v) => activeSet.has(v.code) === filter.active);
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? vouchers.length;
    return vouchers.slice(offset, offset + limit);
  }

  async checkUsage(code: string): Promise<VoucherUsage> {
    const voucher = await this.getVoucher(code);
    if (!voucher) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    const activeRows = await this.connection.exec('/ip/hotspot/active/print', [
      `?user=${code}`,
    ]);
    const active = activeRows.length > 0 ? activeRows[0]! : null;

    let bytesIn = voucher.usage.bytesIn;
    let bytesOut = voucher.usage.bytesOut;
    let uptime = voucher.usage.uptime;

    if (active) {
      bytesIn = parseInt(active['bytes-in'] || '0', 10) || 0;
      bytesOut = parseInt(active['bytes-out'] || '0', 10) || 0;
      uptime = active['uptime'] || uptime;
    }

    const bytesLimit = voucher.limits.dataBytes;
    const limitUptime = voucher.limits.validity;
    const limitUptimeSeconds = voucher.limits.validitySeconds;
    const uptimeSeconds = parseDurationToSeconds(uptime);

    return {
      code,
      profile: voucher.profile,
      mode: 'hotspot',
      isActive: !!active,
      bytesUsed: bytesIn + bytesOut,
      bytesIn,
      bytesOut,
      bytesLimit,
      bytesRemaining: bytesLimit != null ? Math.max(0, bytesLimit - (bytesIn + bytesOut)) : null,
      dataUsedPercentage:
        bytesLimit && bytesLimit > 0
          ? Math.round(((bytesIn + bytesOut) / bytesLimit) * 100)
          : 0,
      uptimeUsed: uptime,
      uptimeUsedSeconds: uptimeSeconds,
      limitUptime,
      limitUptimeSeconds,
      remainingUptime:
        limitUptimeSeconds && limitUptimeSeconds > 0
          ? formatSecondsToDuration(Math.max(0, limitUptimeSeconds - uptimeSeconds))
          : null,
      remainingUptimeSeconds:
        limitUptimeSeconds && limitUptimeSeconds > 0
          ? Math.max(0, limitUptimeSeconds - uptimeSeconds)
          : null,
      timeUsedPercentage:
        limitUptimeSeconds && limitUptimeSeconds > 0
          ? Math.round((uptimeSeconds / limitUptimeSeconds) * 100)
          : 0,
      lastSeen: null, // Hotspot does not track last-seen
      callerId: active ? active['mac-address'] || null : null,
      disabled: voucher.disabled,
      activeSession: active ? this.rowToSession(active) : null,
    };
  }

  async deleteVoucher(code: string): Promise<void> {
    const existing = await this.getVoucher(code);
    if (!existing) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    // Remove active session first
    try {
      const activeRows = await this.connection.exec('/ip/hotspot/active/print', [
        `?user=${code}`,
      ]);
      for (const row of activeRows) {
        await this.connection.exec('/ip/hotspot/active/remove', [`=.id=${row['.id']}`]);
      }
    } catch {
      // Ignore active-session removal errors
    }

    await this.connection.exec('/ip/hotspot/user/remove', [
      `=.id=${existing.raw['.id']}`,
    ]);
  }

  async deleteBulkVouchers(codes: string[]): Promise<BulkResult<string, string>> {
    const result: BulkResult<string, string> = {
      total: codes.length,
      succeeded: [],
      failed: [],
    };
    for (const code of codes) {
      try {
        await this.deleteVoucher(code);
        result.succeeded.push(code);
      } catch (err) {
        result.failed.push({ input: code, error: mapMikrotikError(err) });
      }
    }
    return result;
  }

  async enableVoucher(code: string): Promise<void> {
    const v = await this.getVoucher(code);
    if (!v) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/ip/hotspot/user/enable', [`=.id=${v.raw['.id']}`]);
  }

  async disableVoucher(code: string): Promise<void> {
    const v = await this.getVoucher(code);
    if (!v) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/ip/hotspot/user/disable', [`=.id=${v.raw['.id']}`]);
  }

  async resetVoucherUsage(code: string): Promise<void> {
    const v = await this.getVoucher(code);
    if (!v) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/ip/hotspot/user/reset-counters', [
      `=.id=${v.raw['.id']}`,
    ]);
  }

  async extendVoucher(code: string, extra: Duration): Promise<void> {
    const v = await this.getVoucher(code);
    if (!v) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    const current = v.limits.validitySeconds ?? 0;
    const added = parseDurationToSeconds(extra);
    const newLimit = formatSecondsToDuration(current + added);
    await this.connection.exec('/ip/hotspot/user/set', [
      `=.id=${v.raw['.id']}`,
      `=limit-uptime=${newLimit}`,
    ]);
  }

  async changeVoucherProfile(code: string, newProfile: string): Promise<void> {
    const v = await this.getVoucher(code);
    if (!v) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/ip/hotspot/user/set', [
      `=.id=${v.raw['.id']}`,
      `=profile=${newProfile}`,
    ]);
  }

  // ---------- Sessions ----------

  async listActiveSessions(): Promise<ActiveSession[]> {
    const rows = await this.connection.exec('/ip/hotspot/active/print');
    return rows.map((r) => this.rowToSession(r));
  }

  async getActiveSession(username: string): Promise<ActiveSession | null> {
    const rows = await this.connection.exec('/ip/hotspot/active/print', [
      `?user=${username}`,
    ]);
    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]!);
  }

  async kickSession(username: string): Promise<void> {
    const rows = await this.connection.exec('/ip/hotspot/active/print', [
      `?user=${username}`,
    ]);
    if (rows.length === 0) throw new MikrotikNotFoundError(`No active session for ${username}`);
    for (const r of rows) {
      await this.connection.exec('/ip/hotspot/active/remove', [`=.id=${r['.id']}`]);
    }
  }

  // ---------- Mappers ----------

  private rowToProfile(row: RawResponse): Profile {
    return {
      name: row['name'] || '',
      mode: 'hotspot',
      rateLimit: row['rate-limit'] || null,
      sharedUsers: parseInt(row['shared-users'] || '1', 10) || 1,
      validity: null,
      validitySeconds: null,
      dataLimitBytes: null,
      raw: row,
    };
  }

  private rowToVoucher(row: RawResponse): Voucher {
    const limitUptime = row['limit-uptime'] || null;
    const limitBytes = row['limit-bytes-total']
      ? parseInt(row['limit-bytes-total'], 10) || 0
      : null;
    const bytesIn = parseInt(row['bytes-in'] || '0', 10) || 0;
    const bytesOut = parseInt(row['bytes-out'] || '0', 10) || 0;
    const uptime = row['uptime'] || '0s';

    return {
      code: row['name'] || '',
      profile: row['profile'] || '',
      mode: 'hotspot',
      comment: row['comment'] || '',
      disabled: row['disabled'] === 'true',
      password: row['password'] || null,
      createdAt: null,
      lastSeen: null,
      callerId: null,
      limits: {
        validity: limitUptime,
        validitySeconds: limitUptime ? parseDurationToSeconds(limitUptime) : null,
        dataBytes: limitBytes,
      },
      usage: {
        bytesIn,
        bytesOut,
        bytesTotal: bytesIn + bytesOut,
        uptime,
        uptimeSeconds: parseDurationToSeconds(uptime),
      },
      isActive: false,
      activeSession: null,
      raw: row,
    };
  }

  private rowToSession(row: RawResponse): ActiveSession {
    const uptime = row['uptime'] || '0s';
    return {
      username: row['user'] || '',
      ipAddress: row['address'] || null,
      macAddress: row['mac-address'] || null,
      uptime,
      uptimeSeconds: parseDurationToSeconds(uptime),
      loginAt: parseMikrotikDate(row['login-by'] || null),
      bytesIn: parseInt(row['bytes-in'] || '0', 10) || 0,
      bytesOut: parseInt(row['bytes-out'] || '0', 10) || 0,
      raw: row,
    };
  }
}

// silence unused import warnings for cross-references kept for future use
void normalizeCallerId;
