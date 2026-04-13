/**
 * UserManagerStrategy — implements the IWifiBackend interface against
 * /tool/user-manager/* (RouterOS User Manager v1/v2 RADIUS).
 *
 * This backend is significantly more complex than Hotspot:
 *   - Vouchers are split across `user`, `profile`, `limitation`, and `profile-limitation`
 *   - Path locations differ between RouterOS versions (e.g. `/tool/user-manager/limitation`
 *     vs `/tool/user-manager/profile/limitation`) — we fall back gracefully
 *   - Limits live on the profile's linked limitation, not the user record
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
  formatBytesForMikrotik,
  normalizeRateLimit,
  parseMikrotikDate,
  normalizeCallerId,
} from '../utils/index.js';
import {
  MikrotikNotFoundError,
  MikrotikAlreadyExistsError,
  mapMikrotikError,
} from '../errors.js';

const DEFAULT_COMMENT = 'mikrotik-voucher-manager';
const DEFAULT_CUSTOMER = 'admin';

export class UserManagerStrategy implements IWifiBackend {
  public readonly mode = 'usermanager' as const;
  private readonly customer: string;

  constructor(public readonly connection: Connection, customer = DEFAULT_CUSTOMER) {
    this.customer = customer;
  }

  // ---------- Profiles ----------

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.connection.exec('/tool/user-manager/profile/print', [
      `?owner=${this.customer}`,
    ]);

    const result: Profile[] = [];
    for (const row of rows) {
      const limits = await this.getLimitationsForProfile(row['name'] || '');
      result.push(this.rowToProfile(row, limits));
    }
    return result;
  }

  async getProfile(name: string): Promise<Profile | null> {
    const rows = await this.connection.exec('/tool/user-manager/profile/print', [
      `?name=${name}`,
      `?owner=${this.customer}`,
    ]);
    if (rows.length === 0) return null;
    const limits = await this.getLimitationsForProfile(name);
    return this.rowToProfile(rows[0]!, limits);
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const limitationName = `${input.name}_LIMIT`;

    // Step 1: create limitation
    const limParams = [
      `=name=${limitationName}`,
      `=owner=${this.customer}`,
    ];
    if (input.validity !== undefined) {
      limParams.push(`=uptime-limit=${normalizeDuration(input.validity)}`);
    }
    if (input.dataLimit !== undefined) {
      const bytes = parseByteSize(input.dataLimit);
      if (bytes > 0) {
        limParams.push(`=transfer-limit=${formatBytesForMikrotik(bytes)}`);
      }
    }
    if (input.rateLimit && input.rateLimit.includes('/')) {
      const [upload, download] = input.rateLimit.split('/');
      if (upload) limParams.push(`=rate-limit-rx=${normalizeRateLimit(upload)}`);
      if (download) limParams.push(`=rate-limit-tx=${normalizeRateLimit(download)}`);
    }

    try {
      await this.connection.exec('/tool/user-manager/profile/limitation/add', limParams);
    } catch (err) {
      if (!(err instanceof MikrotikAlreadyExistsError)) {
        // Try alternate path (user-manager v2 has /tool/user-manager/limitation)
        try {
          await this.connection.exec('/tool/user-manager/limitation/add', limParams);
        } catch (err2) {
          if (!(err2 instanceof MikrotikAlreadyExistsError)) {
            throw mapMikrotikError(err2);
          }
        }
      }
    }

    // Step 2: create profile
    const profParams = [
      `=name=${input.name}`,
      `=owner=${this.customer}`,
      `=starts-at=logon`,
    ];
    if (input.sharedUsers != null) {
      profParams.push(`=override-shared-users=${input.sharedUsers}`);
    }
    if (input.validity !== undefined) {
      profParams.push(`=validity=${normalizeDuration(input.validity)}`);
    }

    try {
      await this.connection.exec('/tool/user-manager/profile/add', profParams);
    } catch (err) {
      if (!(err instanceof MikrotikAlreadyExistsError)) throw err;
    }

    // Step 3: link limitation to profile
    try {
      await this.connection.exec('/tool/user-manager/profile/profile-limitation/add', [
        `=profile=${input.name}`,
        `=limitation=${limitationName}`,
      ]);
    } catch (err) {
      if (!(err instanceof MikrotikAlreadyExistsError)) {
        // alt path
        try {
          await this.connection.exec('/tool/user-manager/profile-limitation/add', [
            `=profile=${input.name}`,
            `=limitation=${limitationName}`,
          ]);
        } catch {
          // Best-effort
        }
      }
    }

    const profile = await this.getProfile(input.name);
    if (!profile) {
      throw new MikrotikNotFoundError(`Profile ${input.name} not found after create`);
    }
    return profile;
  }

  async updateProfile(name: string, patch: UpdateProfileInput): Promise<Profile> {
    // Step 1: Update the linked limitation (rate limits, uptime, transfer)
    const limitationName = `${name}_LIMIT`;
    const lim = await this.getLimitationByName(limitationName);
    if (lim && lim['.id']) {
      const params: string[] = [`=.id=${lim['.id']}`];
      if (patch.validity !== undefined) {
        params.push(`=uptime-limit=${normalizeDuration(patch.validity)}`);
      }
      if (patch.dataLimit !== undefined) {
        const bytes = parseByteSize(patch.dataLimit);
        params.push(`=transfer-limit=${bytes > 0 ? formatBytesForMikrotik(bytes) : '0'}`);
      }
      if (patch.rateLimit && patch.rateLimit.includes('/')) {
        const [upload, download] = patch.rateLimit.split('/');
        if (upload) params.push(`=rate-limit-rx=${normalizeRateLimit(upload)}`);
        if (download) params.push(`=rate-limit-tx=${normalizeRateLimit(download)}`);
      }
      if (params.length > 1) {
        await this.execWithFallback('/tool/user-manager/profile/limitation/set', params, [
          '/tool/user-manager/limitation/set',
        ]);
      }
    }

    // Step 2: Update the profile itself (validity, shared-users)
    const rows = await this.connection.exec('/tool/user-manager/profile/print', [
      `?name=${name}`,
    ]);
    const profileRow = rows[0];
    if (profileRow && profileRow['.id']) {
      const profParams: string[] = [`=.id=${profileRow['.id']}`];
      if (patch.validity !== undefined) {
        profParams.push(`=validity=${normalizeDuration(patch.validity)}`);
      }
      if (patch.sharedUsers != null) {
        profParams.push(`=override-shared-users=${patch.sharedUsers}`);
      }
      if (profParams.length > 1) {
        await this.connection.exec('/tool/user-manager/profile/set', profParams);
      }
    }

    const profile = await this.getProfile(name);
    if (!profile) throw new MikrotikNotFoundError(`Profile ${name} not found`);
    return profile;
  }

  async deleteProfile(name: string): Promise<void> {
    const rows = await this.connection.exec('/tool/user-manager/profile/print', [
      `?name=${name}`,
    ]);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Profile ${name} not found`);

    // Remove profile-limitation links first
    try {
      const links = await this.connection.exec(
        '/tool/user-manager/profile/profile-limitation/print',
        [`?profile=${name}`]
      );
      for (const l of links) {
        await this.connection.exec(
          '/tool/user-manager/profile/profile-limitation/remove',
          [`=.id=${l['.id']}`]
        );
      }
    } catch {
      // ignore
    }

    await this.connection.exec('/tool/user-manager/profile/remove', [
      `=.id=${rows[0]!['.id']}`,
    ]);

    // Remove the matching limitation if we created it
    const limitationName = `${name}_LIMIT`;
    try {
      const lim = await this.getLimitationByName(limitationName);
      if (lim && lim['.id']) {
        await this.execWithFallback(
          '/tool/user-manager/profile/limitation/remove',
          [`=.id=${lim['.id']}`],
          ['/tool/user-manager/limitation/remove']
        );
      }
    } catch {
      // ignore
    }
  }

  // ---------- Vouchers ----------

  async createVoucher(input: CreateVoucherInput): Promise<Voucher> {
    // RouterOS 6.x UM v1 uses `=username=`; 7.x UM v2 uses `=name=`.
    // We try username first (the more common legacy path), fall back to name.
    const baseParams = [
      `=password=${input.password ?? input.code}`,
      `=customer=${this.customer}`,
      `=comment=${input.comment ?? DEFAULT_COMMENT}`,
    ];
    if (input.bindOnFirstUse !== false) {
      baseParams.push(`=caller-id-bind-on-first-use=yes`);
    }

    try {
      await this.connection.exec('/tool/user-manager/user/add', [
        `=username=${input.code}`,
        ...baseParams,
      ]);
    } catch (err) {
      const msg = (err as Error)?.message?.toLowerCase() || '';
      if (msg.includes('unknown parameter')) {
        // UM v2 naming
        await this.connection.exec('/tool/user-manager/user/add', [
          `=name=${input.code}`,
          ...baseParams,
        ]);
      } else {
        throw err;
      }
    }

    if (input.profile) {
      try {
        await this.connection.exec(
          '/tool/user-manager/user/create-and-activate-profile',
          [
            `=numbers=${input.code}`,
            `=customer=${this.customer}`,
            `=profile=${input.profile}`,
          ]
        );
      } catch (err) {
        // v2 may not expose create-and-activate-profile — try user/set
        try {
          const rows = await this.connection.exec('/tool/user-manager/user/print', [
            `?name=${input.code}`,
          ]);
          if (rows.length > 0) {
            await this.connection.exec('/tool/user-manager/user/set', [
              `=.id=${rows[0]!['.id']}`,
              `=profile=${input.profile}`,
            ]);
          }
        } catch {
          throw err;
        }
      }
    }

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
    const rows = await this.findUserRows(code);
    if (rows.length === 0) return null;
    const user = rows[0]!;
    const profileName = await this.resolveProfileName(user);
    const limits = profileName
      ? await this.getLimitationsForProfile(profileName)
      : { uptimeLimit: null, transferLimit: null, rateLimit: null };
    return this.rowToVoucher(user, profileName, limits);
  }

  async listVouchers(filter: VoucherFilter = {}): Promise<Voucher[]> {
    const params: string[] = [];
    if (filter.disabled !== undefined) {
      params.push(`?disabled=${filter.disabled ? 'true' : 'false'}`);
    }
    // Use comment filter server-side if provided (faster for large tables)
    if (filter.commentPrefix) {
      params.push(`?comment=${filter.commentPrefix}`);
    }
    const rows = await this.connection.exec('/tool/user-manager/user/print', params);

    const vouchers: Voucher[] = [];
    for (const row of rows) {
      const profileName = await this.resolveProfileName(row);
      if (filter.profile && profileName !== filter.profile) continue;
      const limits = profileName
        ? await this.getLimitationsForProfile(profileName)
        : { uptimeLimit: null, transferLimit: null, rateLimit: null };
      vouchers.push(this.rowToVoucher(row, profileName, limits));
    }

    let filtered = vouchers;
    if (filter.commentPrefix) {
      filtered = filtered.filter((v) => v.comment.startsWith(filter.commentPrefix!));
    }
    if (filter.used !== undefined) {
      filtered = filtered.filter((v) => (v.usage.bytesTotal > 0 || v.lastSeen != null) === filter.used);
    }
    if (filter.active !== undefined) {
      const sessions = await this.listActiveSessions();
      const activeSet = new Set(sessions.map((s) => s.username));
      filtered = filtered.filter((v) => activeSet.has(v.code) === filter.active);
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async checkUsage(code: string): Promise<VoucherUsage> {
    const voucher = await this.getVoucher(code);
    if (!voucher) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    const sessions = await this.listActiveSessions();
    const activeSession = sessions.find((s) => s.username === code) ?? null;

    const bytesUsed = voucher.usage.bytesTotal;
    const uptimeSeconds = voucher.usage.uptimeSeconds;
    const limitBytes = voucher.limits.dataBytes;
    const limitUptime = voucher.limits.validity;
    const limitUptimeSeconds = voucher.limits.validitySeconds;

    return {
      code,
      profile: voucher.profile,
      mode: 'usermanager',
      isActive: !!activeSession,
      bytesUsed,
      bytesIn: voucher.usage.bytesIn,
      bytesOut: voucher.usage.bytesOut,
      bytesLimit: limitBytes,
      bytesRemaining: limitBytes != null ? Math.max(0, limitBytes - bytesUsed) : null,
      dataUsedPercentage:
        limitBytes && limitBytes > 0 ? Math.round((bytesUsed / limitBytes) * 100) : 0,
      uptimeUsed: voucher.usage.uptime,
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
      lastSeen: voucher.lastSeen,
      callerId: voucher.callerId,
      disabled: voucher.disabled,
      activeSession,
    };
  }

  async deleteVoucher(code: string): Promise<void> {
    const rows = await this.findUserRows(code);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    // Remove active sessions
    try {
      const sessions = await this.connection.exec('/tool/user-manager/session/print', [
        `?user=${code}`,
      ]);
      for (const s of sessions) {
        await this.connection.exec('/tool/user-manager/session/remove', [
          `=.id=${s['.id']}`,
        ]);
      }
    } catch {
      // ignore
    }

    await this.connection.exec('/tool/user-manager/user/remove', [
      `=.id=${rows[0]!['.id']}`,
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
    const rows = await this.findUserRows(code);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/tool/user-manager/user/enable', [
      `=.id=${rows[0]!['.id']}`,
    ]);
  }

  async disableVoucher(code: string): Promise<void> {
    const rows = await this.findUserRows(code);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    await this.connection.exec('/tool/user-manager/user/disable', [
      `=.id=${rows[0]!['.id']}`,
    ]);
  }

  async resetVoucherUsage(code: string): Promise<void> {
    const rows = await this.findUserRows(code);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Voucher ${code} not found`);
    const id = rows[0]!['.id'];

    // Try the v2 reset-counters path first
    try {
      await this.connection.exec('/tool/user-manager/user/reset-counters', [`=.id=${id}`]);
      return;
    } catch {
      // fall through to v1 approach
    }

    // v1 approach: re-activate the profile to clear accumulated usage,
    // or best-effort set counters to 0 if the router accepts it
    const user = rows[0]!;
    const profileName = user['actual-profile'] || user['profile'];
    if (profileName && user['username']) {
      try {
        await this.connection.exec(
          '/tool/user-manager/user/create-and-activate-profile',
          [
            `=numbers=${user['username']}`,
            `=customer=${this.customer}`,
            `=profile=${profileName}`,
          ]
        );
        return;
      } catch {
        // ignore
      }
    }
    // If none of the above worked, swallow silently — reset is best-effort
    // on RouterOS versions that don't expose it.
  }

  async extendVoucher(code: string, extra: Duration): Promise<void> {
    const voucher = await this.getVoucher(code);
    if (!voucher) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    // Extend via the linked limitation of the voucher's profile
    if (!voucher.profile) {
      throw new MikrotikNotFoundError(`Voucher ${code} has no profile`);
    }
    const limitationName = `${voucher.profile}_LIMIT`;
    const lim = await this.getLimitationByName(limitationName);
    if (!lim) throw new MikrotikNotFoundError(`Limitation ${limitationName} not found`);

    const currentLimit = parseDurationToSeconds(lim['uptime-limit'] || '0s');
    const newLimit = formatSecondsToDuration(currentLimit + parseDurationToSeconds(extra));

    await this.execWithFallback(
      '/tool/user-manager/profile/limitation/set',
      [`=.id=${lim['.id']}`, `=uptime-limit=${newLimit}`],
      ['/tool/user-manager/limitation/set']
    );
  }

  async changeVoucherProfile(code: string, newProfile: string): Promise<void> {
    const rows = await this.findUserRows(code);
    if (rows.length === 0) throw new MikrotikNotFoundError(`Voucher ${code} not found`);

    try {
      await this.connection.exec(
        '/tool/user-manager/user/create-and-activate-profile',
        [
          `=numbers=${code}`,
          `=customer=${this.customer}`,
          `=profile=${newProfile}`,
        ]
      );
    } catch {
      // Fall back to user/set
      await this.connection.exec('/tool/user-manager/user/set', [
        `=.id=${rows[0]!['.id']}`,
        `=profile=${newProfile}`,
      ]);
    }
  }

  // ---------- Sessions ----------

  async listActiveSessions(): Promise<ActiveSession[]> {
    const rows = await this.connection.exec('/tool/user-manager/session/print');
    return rows
      .filter((r) => r['active'] === 'true' || r['active'] === 'yes')
      .map((r) => this.rowToSession(r));
  }

  async getActiveSession(username: string): Promise<ActiveSession | null> {
    const rows = await this.connection.exec('/tool/user-manager/session/print', [
      `?user=${username}`,
    ]);
    const active = rows.find((r) => r['active'] === 'true' || r['active'] === 'yes');
    return active ? this.rowToSession(active) : null;
  }

  async kickSession(username: string): Promise<void> {
    const rows = await this.connection.exec('/tool/user-manager/session/print', [
      `?user=${username}`,
    ]);
    if (rows.length === 0) throw new MikrotikNotFoundError(`No sessions for ${username}`);
    for (const r of rows) {
      try {
        await this.connection.exec('/tool/user-manager/session/remove', [
          `=.id=${r['.id']}`,
        ]);
      } catch {
        // ignore individual removal failures
      }
    }
  }

  // ---------- Internal helpers ----------

  private async findUserRows(code: string): Promise<RawResponse[]> {
    // UM v1 uses `username`, UM v2 uses `name`. Query username first
    // (most common), fall back to name.
    let rows: RawResponse[] = [];
    try {
      rows = await this.connection.exec('/tool/user-manager/user/print', [
        `?username=${code}`,
      ]);
    } catch {
      // fall through
    }
    if (rows.length === 0) {
      try {
        rows = await this.connection.exec('/tool/user-manager/user/print', [
          `?name=${code}`,
        ]);
      } catch {
        // ignore
      }
    }
    return rows;
  }

  private async resolveProfileName(user: RawResponse): Promise<string> {
    // Try fields in order
    const direct = user['actual-profile'] || user['profile'] || '';
    if (direct) return direct;

    // Try user-profile link table
    try {
      const username = user['name'] || user['username'] || '';
      const rows = await this.connection.exec('/tool/user-manager/user-profile/print', [
        `?user=${username}`,
      ]);
      if (rows.length > 0) return rows[0]!['profile'] || '';
    } catch {
      // ignore
    }
    return '';
  }

  private async getLimitationByName(name: string): Promise<RawResponse | null> {
    try {
      const rows = await this.connection.exec(
        '/tool/user-manager/profile/limitation/print',
        [`?name=${name}`]
      );
      if (rows.length > 0) return rows[0]!;
    } catch {
      // try alt path
    }
    try {
      const rows = await this.connection.exec('/tool/user-manager/limitation/print', [
        `?name=${name}`,
      ]);
      if (rows.length > 0) return rows[0]!;
    } catch {
      // ignore
    }
    return null;
  }

  private async getLimitationsForProfile(profileName: string): Promise<{
    uptimeLimit: string | null;
    transferLimit: number | null;
    rateLimit: string | null;
  }> {
    if (!profileName) return { uptimeLimit: null, transferLimit: null, rateLimit: null };

    // Try profile-limitation link table
    let links: RawResponse[] = [];
    try {
      links = await this.connection.exec(
        '/tool/user-manager/profile/profile-limitation/print',
        [`?profile=${profileName}`]
      );
    } catch {
      try {
        links = await this.connection.exec(
          '/tool/user-manager/profile-limitation/print',
          [`?profile=${profileName}`]
        );
      } catch {
        // ignore
      }
    }

    const limitationNames: string[] = [];
    for (const link of links) {
      if (link['limitation']) limitationNames.push(link['limitation']);
    }
    if (limitationNames.length === 0) {
      // Fallback convention: <profile>_LIMIT
      limitationNames.push(`${profileName}_LIMIT`);
    }

    let uptimeLimit: string | null = null;
    let transferLimit: number | null = null;
    let rateLimit: string | null = null;

    for (const name of limitationNames) {
      const lim = await this.getLimitationByName(name);
      if (!lim) continue;
      if (lim['uptime-limit']) uptimeLimit = lim['uptime-limit'];
      if (lim['transfer-limit']) {
        transferLimit = parseByteSize(lim['transfer-limit']);
      }
      const rx = lim['rate-limit-rx'];
      const tx = lim['rate-limit-tx'];
      if (rx || tx) rateLimit = `${rx || '0'}/${tx || '0'}`;
    }

    return { uptimeLimit, transferLimit, rateLimit };
  }

  private async execWithFallback(
    path: string,
    params: string[],
    fallbackPaths: string[]
  ): Promise<RawResponse[]> {
    try {
      return await this.connection.exec(path, params);
    } catch (err) {
      for (const fb of fallbackPaths) {
        try {
          return await this.connection.exec(fb, params);
        } catch {
          // try next
        }
      }
      throw mapMikrotikError(err);
    }
  }

  // ---------- Mappers ----------

  private rowToProfile(
    row: RawResponse,
    limits: { uptimeLimit: string | null; transferLimit: number | null; rateLimit: string | null }
  ): Profile {
    return {
      name: row['name'] || '',
      mode: 'usermanager',
      rateLimit: limits.rateLimit,
      sharedUsers: parseInt(row['override-shared-users'] || row['shared-users'] || '1', 10) || 1,
      validity: limits.uptimeLimit || row['validity'] || null,
      validitySeconds: limits.uptimeLimit ? parseDurationToSeconds(limits.uptimeLimit) : null,
      dataLimitBytes: limits.transferLimit,
      raw: row,
    };
  }

  private rowToVoucher(
    row: RawResponse,
    profileName: string,
    limits: { uptimeLimit: string | null; transferLimit: number | null; rateLimit: string | null }
  ): Voucher {
    const bytesIn = parseInt(row['download-used'] || row['download'] || '0', 10) || 0;
    const bytesOut = parseInt(row['upload-used'] || row['upload'] || '0', 10) || 0;
    const uptime = row['uptime-used'] || row['uptime'] || '0s';

    return {
      code: row['username'] || row['name'] || '',
      profile: profileName,
      mode: 'usermanager',
      comment: row['comment'] || '',
      disabled: row['disabled'] === 'true',
      password: row['password'] || null,
      createdAt: null,
      lastSeen: parseMikrotikDate(row['last-seen']),
      callerId: normalizeCallerId(row['caller-id']),
      limits: {
        validity: limits.uptimeLimit,
        validitySeconds: limits.uptimeLimit ? parseDurationToSeconds(limits.uptimeLimit) : null,
        dataBytes: limits.transferLimit,
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
      ipAddress: row['from-address'] || row['address'] || null,
      macAddress: row['caller-id'] || null,
      uptime,
      uptimeSeconds: parseDurationToSeconds(uptime),
      loginAt: parseMikrotikDate(row['started']),
      bytesIn: parseInt(row['download'] || '0', 10) || 0,
      bytesOut: parseInt(row['upload'] || '0', 10) || 0,
      raw: row,
    };
  }
}
