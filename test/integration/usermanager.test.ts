import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getIntegrationConfig, TEST_PREFIX } from './env.js';
import { MikrotikClient } from '../../src/index.js';

const cfg = getIntegrationConfig();

/**
 * User Manager tests are skipped if the user-manager package is not available
 * on the target router (detected at runtime via system.detectUserManagerVersion).
 */
const describeOrSkip = cfg ? describe : describe.skip;

describeOrSkip('integration: usermanager', () => {
  let client: MikrotikClient;
  let umAvailable = false;

  const profileName = `${TEST_PREFIX}-umprofile`;
  const voucherCode = `${TEST_PREFIX}-umv1`;
  const bulkCodes = [
    `${TEST_PREFIX}-umb1`,
    `${TEST_PREFIX}-umb2`,
  ];

  beforeAll(async () => {
    // First check availability with a tiny client
    const probe = new MikrotikClient({
      host: cfg!.host,
      port: cfg!.port,
      username: cfg!.username,
      password: cfg!.password,
      mode: 'hotspot',
    });
    await probe.connect();
    const version = await probe.system.detectUserManagerVersion();
    await probe.disconnect();

    umAvailable = version !== 'none';

    if (!umAvailable) {
      console.warn(
        '[integration] user-manager package not available on router — tests will be skipped'
      );
      return;
    }

    client = new MikrotikClient({
      host: cfg!.host,
      port: cfg!.port,
      username: cfg!.username,
      password: cfg!.password,
      mode: 'usermanager',
      customer: cfg!.umCustomer,
    });
    await client.connect();
    await cleanup(client);
  });

  afterAll(async () => {
    if (client && umAvailable) {
      try {
        await cleanup(client);
      } finally {
        await client.disconnect();
      }
    }
  });

  it('creates a user-manager profile with limits', async () => {
    if (!umAvailable) return;
    const profile = await client.profiles.create({
      name: profileName,
      validity: '1h',
      dataLimit: '100MB',
      rateLimit: '512k/2M',
    });
    expect(profile.name).toBe(profileName);
    expect(profile.mode).toBe('usermanager');
    expect(profile.validity).toBe('1h');
  });

  it('lists profiles', async () => {
    if (!umAvailable) return;
    const profiles = await client.profiles.list();
    expect(profiles.some((p) => p.name === profileName)).toBe(true);
  });

  it('creates a voucher', async () => {
    if (!umAvailable) return;
    const voucher = await client.vouchers.create({
      code: voucherCode,
      profile: profileName,
      comment: TEST_PREFIX,
    });
    expect(voucher.code).toBe(voucherCode);
    expect(voucher.profile).toBe(profileName);
  });

  it('gets the voucher', async () => {
    if (!umAvailable) return;
    const v = await client.vouchers.get(voucherCode);
    expect(v).not.toBeNull();
    expect(v!.code).toBe(voucherCode);
  });

  it('checks voucher usage', async () => {
    if (!umAvailable) return;
    const usage = await client.vouchers.checkUsage(voucherCode);
    expect(usage.code).toBe(voucherCode);
    expect(usage.bytesUsed).toBe(0);
    expect(usage.mode).toBe('usermanager');
    expect(usage.disabled).toBe(false);
  });

  it('disables and enables the voucher', async () => {
    if (!umAvailable) return;
    await client.vouchers.disable(voucherCode);
    let v = await client.vouchers.get(voucherCode);
    expect(v!.disabled).toBe(true);

    await client.vouchers.enable(voucherCode);
    v = await client.vouchers.get(voucherCode);
    expect(v!.disabled).toBe(false);
  });

  it('extends voucher validity', async () => {
    if (!umAvailable) return;
    const before = await client.vouchers.get(voucherCode);
    const beforeSeconds = before!.limits.validitySeconds ?? 0;
    await client.vouchers.extend(voucherCode, '15m');
    const after = await client.vouchers.get(voucherCode);
    const afterSeconds = after!.limits.validitySeconds ?? 0;
    expect(afterSeconds).toBe(beforeSeconds + 15 * 60);
  });

  it('creates bulk vouchers', async () => {
    if (!umAvailable) return;
    const result = await client.vouchers.createBulk(
      bulkCodes.map((code) => ({ code, profile: profileName, comment: TEST_PREFIX }))
    );
    expect(result.total).toBe(2);
    expect(result.succeeded.length).toBe(2);
  });

  it('lists vouchers (with comment filter)', async () => {
    if (!umAvailable) return;
    const vouchers = await client.vouchers.list({ commentPrefix: TEST_PREFIX });
    const codes = vouchers.map((v) => v.code);
    expect(codes).toContain(voucherCode);
    for (const b of bulkCodes) expect(codes).toContain(b);
  });

  it('deletes voucher', async () => {
    if (!umAvailable) return;
    await client.vouchers.delete(voucherCode);
    const v = await client.vouchers.get(voucherCode);
    expect(v).toBeNull();
  });

  it('bulk deletes vouchers', async () => {
    if (!umAvailable) return;
    const result = await client.vouchers.deleteBulk(bulkCodes);
    expect(result.succeeded.length).toBe(2);
  });

  it('deletes profile', async () => {
    if (!umAvailable) return;
    await client.profiles.delete(profileName);
    const p = await client.profiles.get(profileName);
    expect(p).toBeNull();
  });
});

async function cleanup(client: MikrotikClient): Promise<void> {
  try {
    const vouchers = await client.vouchers.list({ commentPrefix: TEST_PREFIX });
    for (const v of vouchers) {
      try {
        await client.vouchers.delete(v.code);
      } catch {}
    }
  } catch {}

  try {
    const profiles = await client.profiles.list();
    for (const p of profiles) {
      if (p.name.startsWith(TEST_PREFIX)) {
        try {
          await client.profiles.delete(p.name);
        } catch {}
      }
    }
  } catch {}
}
