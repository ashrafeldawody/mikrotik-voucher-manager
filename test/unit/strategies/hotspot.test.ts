import { describe, it, expect, beforeEach } from 'vitest';
import { FakeConnection } from '../fakes/FakeConnection.js';
import { HotspotStrategy } from '../../../src/strategies/hotspot.js';
import { MikrotikNotFoundError } from '../../../src/errors.js';
import type { Connection } from '../../../src/connection.js';

describe('HotspotStrategy', () => {
  let fake: FakeConnection;
  let strategy: HotspotStrategy;

  beforeEach(() => {
    fake = new FakeConnection();
    // FakeConnection is duck-typed to Connection for our purposes.
    strategy = new HotspotStrategy(fake as unknown as Connection);
  });

  describe('createProfile', () => {
    it('emits correct command with rate limit and shared users', async () => {
      fake.respond('/ip/hotspot/user/profile/add', []);
      fake.respond('/ip/hotspot/user/profile/print', [
        { '.id': '*1', name: 'vip', 'rate-limit': '10M/20M', 'shared-users': '3' },
      ]);

      const profile = await strategy.createProfile({
        name: 'vip',
        rateLimit: '10M/20M',
        sharedUsers: 3,
      });

      expect(profile.name).toBe('vip');
      expect(profile.rateLimit).toBe('10M/20M');
      expect(profile.sharedUsers).toBe(3);
      expect(profile.mode).toBe('hotspot');

      const addCall = fake.lastCallTo('/ip/hotspot/user/profile/add');
      expect(addCall).toBeDefined();
      expect(addCall!.params).toContain('=name=vip');
      expect(addCall!.params).toContain('=rate-limit=10M/20M');
      expect(addCall!.params).toContain('=shared-users=3');
    });
  });

  describe('updateProfile', () => {
    it('updates rate-limit and shared-users via profile/set', async () => {
      fake.respond('/ip/hotspot/user/profile/print', [
        { '.id': '*1', name: 'vip', 'rate-limit': '10M/20M', 'shared-users': '3' },
      ]);
      fake.respond('/ip/hotspot/user/profile/set', []);

      const profile = await strategy.updateProfile('vip', {
        rateLimit: '20M/40M',
        sharedUsers: 5,
      });

      expect(profile.name).toBe('vip');

      const setCall = fake.lastCallTo('/ip/hotspot/user/profile/set');
      expect(setCall).toBeDefined();
      expect(setCall!.params).toContain('=.id=*1');
      expect(setCall!.params).toContain('=rate-limit=20M/40M');
      expect(setCall!.params).toContain('=shared-users=5');
    });

    it('throws MikrotikNotFoundError when profile does not exist', async () => {
      fake.respond('/ip/hotspot/user/profile/print', []);
      await expect(strategy.updateProfile('nope', { rateLimit: '1M/1M' }))
        .rejects.toBeInstanceOf(MikrotikNotFoundError);
    });

    it('skips set command when patch is empty', async () => {
      fake.respond('/ip/hotspot/user/profile/print', [
        { '.id': '*1', name: 'vip', 'rate-limit': '10M/20M', 'shared-users': '3' },
      ]);

      await strategy.updateProfile('vip', {});

      const setCall = fake.lastCallTo('/ip/hotspot/user/profile/set');
      expect(setCall).toBeUndefined();
    });
  });

  describe('createVoucher', () => {
    it('creates a voucher with validity and data limit', async () => {
      fake.respond('/ip/hotspot/user/add', []);
      fake.respond('/ip/hotspot/user/print', [
        {
          '.id': '*2',
          name: 'CARD001',
          profile: 'vip',
          'limit-uptime': '1h',
          'limit-bytes-total': '1073741824',
          comment: 'mikrotik-voucher-manager',
          disabled: 'false',
          'bytes-in': '0',
          'bytes-out': '0',
          uptime: '0s',
        },
      ]);

      const voucher = await strategy.createVoucher({
        code: 'CARD001',
        profile: 'vip',
        validity: '1h',
        dataLimit: '1GB',
      });

      expect(voucher.code).toBe('CARD001');
      expect(voucher.profile).toBe('vip');
      expect(voucher.limits.validity).toBe('1h');
      expect(voucher.limits.dataBytes).toBe(1073741824);

      const addCall = fake.lastCallTo('/ip/hotspot/user/add');
      expect(addCall!.params).toContain('=name=CARD001');
      expect(addCall!.params).toContain('=profile=vip');
      expect(addCall!.params).toContain('=limit-uptime=1h');
      expect(addCall!.params).toContain('=limit-bytes-total=1073741824');
      expect(addCall!.params).toContain('=comment=mikrotik-voucher-manager');
    });

    it('omits data limit if not provided', async () => {
      fake.respond('/ip/hotspot/user/add', []);
      fake.respond('/ip/hotspot/user/print', [
        { '.id': '*1', name: 'C', profile: 'p', disabled: 'false' },
      ]);
      await strategy.createVoucher({ code: 'C', profile: 'p' });
      const addCall = fake.lastCallTo('/ip/hotspot/user/add');
      expect(addCall!.params.some((p) => p.startsWith('=limit-bytes-total='))).toBe(false);
    });
  });

  describe('createBulkVouchers', () => {
    it('collects successes and failures', async () => {
      let callIndex = 0;
      fake.respond('/ip/hotspot/user/add', (_params) => {
        callIndex++;
        if (callIndex === 2) return new Error('already have user with this name');
        return [];
      });
      fake.respond('/ip/hotspot/user/print', (params) => {
        const name = params[0]?.replace('?name=', '') ?? '';
        return [{ '.id': '*x', name, profile: 'p', disabled: 'false' }];
      });

      const result = await strategy.createBulkVouchers([
        { code: 'A', profile: 'p' },
        { code: 'B', profile: 'p' },
        { code: 'C', profile: 'p' },
      ]);

      expect(result.total).toBe(3);
      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.input.code).toBe('B');
    });
  });

  describe('getVoucher', () => {
    it('returns null when not found', async () => {
      fake.respond('/ip/hotspot/user/print', []);
      expect(await strategy.getVoucher('NONE')).toBe(null);
    });

    it('maps raw row to Voucher', async () => {
      fake.respond('/ip/hotspot/user/print', [
        {
          '.id': '*3',
          name: 'CARD',
          profile: 'p',
          'limit-uptime': '2h',
          'limit-bytes-total': '2097152',
          comment: 'test',
          disabled: 'false',
          'bytes-in': '1024',
          'bytes-out': '512',
          uptime: '15m',
        },
      ]);
      const v = await strategy.getVoucher('CARD');
      expect(v).not.toBeNull();
      expect(v!.usage.bytesIn).toBe(1024);
      expect(v!.usage.bytesOut).toBe(512);
      expect(v!.usage.bytesTotal).toBe(1536);
      expect(v!.usage.uptimeSeconds).toBe(900);
    });
  });

  describe('checkUsage', () => {
    it('throws MikrotikNotFoundError if voucher missing', async () => {
      fake.respond('/ip/hotspot/user/print', []);
      await expect(strategy.checkUsage('X')).rejects.toBeInstanceOf(MikrotikNotFoundError);
    });

    it('computes percentages and remaining values', async () => {
      fake.respond('/ip/hotspot/user/print', [
        {
          '.id': '*1',
          name: 'C',
          profile: 'p',
          'limit-uptime': '1h',
          'limit-bytes-total': '1000',
          disabled: 'false',
          'bytes-in': '200',
          'bytes-out': '300',
          uptime: '30m',
        },
      ]);
      fake.respond('/ip/hotspot/active/print', []); // not active

      const usage = await strategy.checkUsage('C');
      expect(usage.bytesUsed).toBe(500);
      expect(usage.bytesRemaining).toBe(500);
      expect(usage.dataUsedPercentage).toBe(50);
      expect(usage.uptimeUsedSeconds).toBe(1800);
      expect(usage.remainingUptimeSeconds).toBe(1800);
      expect(usage.timeUsedPercentage).toBe(50);
      expect(usage.isActive).toBe(false);
    });

    it('prefers active-session values when voucher is online', async () => {
      fake.respond('/ip/hotspot/user/print', [
        {
          '.id': '*1',
          name: 'C',
          profile: 'p',
          disabled: 'false',
          'bytes-in': '0',
          'bytes-out': '0',
          uptime: '0s',
        },
      ]);
      fake.respond('/ip/hotspot/active/print', [
        {
          '.id': '*11',
          user: 'C',
          'bytes-in': '9999',
          'bytes-out': '1',
          uptime: '10m',
          address: '192.168.1.50',
          'mac-address': 'AA:BB:CC:DD:EE:FF',
        },
      ]);

      const usage = await strategy.checkUsage('C');
      expect(usage.isActive).toBe(true);
      expect(usage.bytesUsed).toBe(10000);
      expect(usage.activeSession?.ipAddress).toBe('192.168.1.50');
      expect(usage.callerId).toBe('AA:BB:CC:DD:EE:FF');
    });
  });

  describe('deleteVoucher', () => {
    it('removes active session and user', async () => {
      fake.respond('/ip/hotspot/user/print', [{ '.id': '*7', name: 'C', profile: 'p', disabled: 'false' }]);
      fake.respond('/ip/hotspot/active/print', [{ '.id': '*55', user: 'C' }]);
      fake.respond('/ip/hotspot/active/remove', []);
      fake.respond('/ip/hotspot/user/remove', []);

      await strategy.deleteVoucher('C');

      expect(fake.lastCallTo('/ip/hotspot/active/remove')!.params).toContain('=.id=*55');
      expect(fake.lastCallTo('/ip/hotspot/user/remove')!.params).toContain('=.id=*7');
    });

    it('throws when voucher not found', async () => {
      fake.respond('/ip/hotspot/user/print', []);
      await expect(strategy.deleteVoucher('X')).rejects.toBeInstanceOf(MikrotikNotFoundError);
    });
  });

  describe('enable/disable/reset/extend/changeProfile', () => {
    const voucherRow = {
      '.id': '*9',
      name: 'C',
      profile: 'p',
      'limit-uptime': '30m',
      disabled: 'false',
      'bytes-in': '0',
      'bytes-out': '0',
      uptime: '0s',
    };

    beforeEach(() => {
      fake.respond('/ip/hotspot/user/print', [voucherRow]);
      fake.respond('/ip/hotspot/user/enable', []);
      fake.respond('/ip/hotspot/user/disable', []);
      fake.respond('/ip/hotspot/user/set', []);
      fake.respond('/ip/hotspot/user/reset-counters', []);
    });

    it('enable calls /enable with id', async () => {
      await strategy.enableVoucher('C');
      expect(fake.lastCallTo('/ip/hotspot/user/enable')!.params).toContain('=.id=*9');
    });

    it('disable calls /disable with id', async () => {
      await strategy.disableVoucher('C');
      expect(fake.lastCallTo('/ip/hotspot/user/disable')!.params).toContain('=.id=*9');
    });

    it('resetUsage calls reset-counters', async () => {
      await strategy.resetVoucherUsage('C');
      expect(fake.lastCallTo('/ip/hotspot/user/reset-counters')!.params).toContain('=.id=*9');
    });

    it('extend adds to existing limit-uptime', async () => {
      await strategy.extendVoucher('C', '15m');
      const setCall = fake.lastCallTo('/ip/hotspot/user/set')!;
      expect(setCall.params).toContain('=.id=*9');
      // 30m + 15m = 45m
      expect(setCall.params).toContain('=limit-uptime=45m');
    });

    it('changeProfile updates profile field', async () => {
      await strategy.changeVoucherProfile('C', 'premium');
      const setCall = fake.lastCallTo('/ip/hotspot/user/set')!;
      expect(setCall.params).toContain('=profile=premium');
    });
  });

  describe('kickSession', () => {
    it('removes matching active sessions', async () => {
      fake.respond('/ip/hotspot/active/print', [{ '.id': '*k1', user: 'U' }]);
      fake.respond('/ip/hotspot/active/remove', []);
      await strategy.kickSession('U');
      expect(fake.lastCallTo('/ip/hotspot/active/remove')!.params).toContain('=.id=*k1');
    });

    it('throws when no session', async () => {
      fake.respond('/ip/hotspot/active/print', []);
      await expect(strategy.kickSession('U')).rejects.toBeInstanceOf(MikrotikNotFoundError);
    });
  });
});
