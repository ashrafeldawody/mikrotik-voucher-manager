import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getIntegrationConfig, TEST_PREFIX } from './env.js';
import { MikrotikClient } from '../../src/index.js';
import {
  MikrotikNotFoundError,
} from '../../src/errors.js';

const cfg = getIntegrationConfig();
const describeOrSkip = cfg ? describe : describe.skip;

describeOrSkip('integration: hotspot', () => {
  let client: MikrotikClient;
  const profileName = `${TEST_PREFIX}-profile`;
  const voucherCode = `${TEST_PREFIX}-v1`;
  const bulkCodes = [
    `${TEST_PREFIX}-b1`,
    `${TEST_PREFIX}-b2`,
    `${TEST_PREFIX}-b3`,
  ];

  beforeAll(async () => {
    client = new MikrotikClient({
      host: cfg!.host,
      port: cfg!.port,
      username: cfg!.username,
      password: cfg!.password,
      mode: 'hotspot',
    });
    await client.connect();
    await cleanup(client);
  });

  afterAll(async () => {
    if (client) {
      try {
        await cleanup(client);
      } finally {
        await client.disconnect();
      }
    }
  });

  it('creates a hotspot profile', async () => {
    const profile = await client.profiles.create({
      name: profileName,
      rateLimit: '1M/2M',
      sharedUsers: 1,
    });
    expect(profile.name).toBe(profileName);
    expect(profile.mode).toBe('hotspot');
    expect(profile.rateLimit).toBe('1M/2M');
  });

  it('lists the profile', async () => {
    const profiles = await client.profiles.list();
    expect(profiles.some((p) => p.name === profileName)).toBe(true);
  });

  it('gets the profile by name', async () => {
    const profile = await client.profiles.get(profileName);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe(profileName);
  });

  it('creates a voucher with validity and data limit', async () => {
    const voucher = await client.vouchers.create({
      code: voucherCode,
      profile: profileName,
      validity: '1h',
      dataLimit: '100MB',
      comment: TEST_PREFIX,
    });
    expect(voucher.code).toBe(voucherCode);
    expect(voucher.profile).toBe(profileName);
    expect(voucher.limits.validity).toBe('1h');
    expect(voucher.limits.dataBytes).toBe(100 * 1024 * 1024);
    expect(voucher.disabled).toBe(false);
  });

  it('gets the voucher', async () => {
    const voucher = await client.vouchers.get(voucherCode);
    expect(voucher).not.toBeNull();
    expect(voucher!.code).toBe(voucherCode);
  });

  it('checks voucher usage', async () => {
    const usage = await client.vouchers.checkUsage(voucherCode);
    expect(usage.code).toBe(voucherCode);
    expect(usage.bytesUsed).toBe(0);
    expect(usage.dataUsedPercentage).toBe(0);
    expect(usage.isActive).toBe(false);
  });

  it('disables and enables the voucher', async () => {
    await client.vouchers.disable(voucherCode);
    let v = await client.vouchers.get(voucherCode);
    expect(v!.disabled).toBe(true);

    await client.vouchers.enable(voucherCode);
    v = await client.vouchers.get(voucherCode);
    expect(v!.disabled).toBe(false);
  });

  it('extends the voucher validity', async () => {
    await client.vouchers.extend(voucherCode, '30m');
    const v = await client.vouchers.get(voucherCode);
    // 1h + 30m = 1h30m = 5400s
    expect(v!.limits.validitySeconds).toBe(5400);
  });

  it('resets voucher usage counters', async () => {
    await client.vouchers.resetUsage(voucherCode);
    const usage = await client.vouchers.checkUsage(voucherCode);
    expect(usage.bytesUsed).toBe(0);
  });

  it('creates bulk vouchers', async () => {
    const result = await client.vouchers.createBulk(
      bulkCodes.map((code) => ({
        code,
        profile: profileName,
        validity: '30m',
        comment: TEST_PREFIX,
      }))
    );
    expect(result.total).toBe(3);
    expect(result.succeeded.length).toBe(3);
    expect(result.failed.length).toBe(0);
  });

  it('lists vouchers by profile', async () => {
    const vouchers = await client.vouchers.list({ profile: profileName });
    const codes = vouchers.map((v) => v.code);
    expect(codes).toContain(voucherCode);
    for (const b of bulkCodes) expect(codes).toContain(b);
  });

  it('lists active sessions (empty for test entities)', async () => {
    const sessions = await client.sessions.list();
    expect(Array.isArray(sessions)).toBe(true);
    // Our created vouchers have no sessions
    for (const b of bulkCodes) {
      expect(sessions.find((s) => s.username === b)).toBeUndefined();
    }
  });

  it('deletes individual voucher', async () => {
    await client.vouchers.delete(voucherCode);
    const v = await client.vouchers.get(voucherCode);
    expect(v).toBeNull();
  });

  it('bulk deletes remaining vouchers', async () => {
    const result = await client.vouchers.deleteBulk(bulkCodes);
    expect(result.succeeded.length).toBe(3);
    expect(result.failed.length).toBe(0);
  });

  it('deletes the profile', async () => {
    await client.profiles.delete(profileName);
    const p = await client.profiles.get(profileName);
    expect(p).toBeNull();
  });

  it('throws MikrotikNotFoundError on missing entities', async () => {
    await expect(client.profiles.delete('nonexistent-' + TEST_PREFIX)).rejects.toBeInstanceOf(
      MikrotikNotFoundError
    );
    await expect(client.vouchers.delete('nonexistent-' + TEST_PREFIX)).rejects.toBeInstanceOf(
      MikrotikNotFoundError
    );
  });
});

/**
 * Best-effort cleanup: remove every voucher and profile with our test prefix.
 */
async function cleanup(client: MikrotikClient): Promise<void> {
  try {
    const vouchers = await client.vouchers.list({ commentPrefix: TEST_PREFIX });
    for (const v of vouchers) {
      try {
        await client.vouchers.delete(v.code);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    const profiles = await client.profiles.list();
    for (const p of profiles) {
      if (p.name.startsWith(TEST_PREFIX)) {
        try {
          await client.profiles.delete(p.name);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}
