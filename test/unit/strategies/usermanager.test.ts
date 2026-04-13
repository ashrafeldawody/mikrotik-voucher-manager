import { describe, it, expect, beforeEach } from 'vitest';
import { FakeConnection } from '../fakes/FakeConnection.js';
import { UserManagerStrategy } from '../../../src/strategies/usermanager.js';
import { MikrotikNotFoundError, MikrotikAlreadyExistsError } from '../../../src/errors.js';
import type { Connection } from '../../../src/connection.js';

describe('UserManagerStrategy', () => {
  let fake: FakeConnection;
  let strategy: UserManagerStrategy;

  beforeEach(() => {
    fake = new FakeConnection();
    strategy = new UserManagerStrategy(fake as unknown as Connection, 'admin');
  });

  describe('createProfile', () => {
    it('creates limitation, profile, and link', async () => {
      fake.respond('/tool/user-manager/profile/limitation/add', []);
      fake.respond('/tool/user-manager/profile/add', []);
      fake.respond('/tool/user-manager/profile/profile-limitation/add', []);

      fake.respond('/tool/user-manager/profile/print', [
        { '.id': '*1', name: 'vip', owner: 'admin' },
      ]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', [
        { '.id': '*l1', profile: 'vip', limitation: 'vip_LIMIT' },
      ]);
      fake.respond('/tool/user-manager/profile/limitation/print', [
        {
          '.id': '*lim1',
          name: 'vip_LIMIT',
          'uptime-limit': '1h',
          'transfer-limit': '1G',
          'rate-limit-rx': '512k',
          'rate-limit-tx': '4M',
        },
      ]);

      const profile = await strategy.createProfile({
        name: 'vip',
        validity: '1h',
        dataLimit: '1GB',
        rateLimit: '512k/4M',
      });

      expect(profile.name).toBe('vip');
      expect(profile.mode).toBe('usermanager');
      expect(profile.validity).toBe('1h');
      // 1G is stored in MT as '1G' which parses back to 1024^3
      expect(profile.dataLimitBytes).toBe(1024 * 1024 * 1024);
      expect(profile.rateLimit).toBe('512k/4M');

      const limAdd = fake.lastCallTo('/tool/user-manager/profile/limitation/add');
      expect(limAdd!.params).toContain('=name=vip_LIMIT');
      expect(limAdd!.params).toContain('=owner=admin');
      expect(limAdd!.params).toContain('=uptime-limit=1h');
      expect(limAdd!.params).toContain('=transfer-limit=1G');
      expect(limAdd!.params).toContain('=rate-limit-rx=512k');
      expect(limAdd!.params).toContain('=rate-limit-tx=4M');

      const profAdd = fake.lastCallTo('/tool/user-manager/profile/add');
      expect(profAdd!.params).toContain('=name=vip');
      expect(profAdd!.params).toContain('=owner=admin');
      expect(profAdd!.params).toContain('=validity=1h');

      const linkAdd = fake.lastCallTo('/tool/user-manager/profile/profile-limitation/add');
      expect(linkAdd!.params).toContain('=profile=vip');
      expect(linkAdd!.params).toContain('=limitation=vip_LIMIT');
    });

    it('tolerates already-exists errors', async () => {
      fake.respond(
        '/tool/user-manager/profile/limitation/add',
        new MikrotikAlreadyExistsError('already have')
      );
      fake.respond(
        '/tool/user-manager/profile/add',
        new MikrotikAlreadyExistsError('already have')
      );
      fake.respond(
        '/tool/user-manager/profile/profile-limitation/add',
        new MikrotikAlreadyExistsError('already have')
      );
      fake.respond('/tool/user-manager/profile/print', [{ '.id': '*1', name: 'p' }]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', []);
      fake.respond('/tool/user-manager/profile/limitation/print', [
        { '.id': '*l', name: 'p_LIMIT' },
      ]);

      const profile = await strategy.createProfile({ name: 'p', validity: '1h' });
      expect(profile.name).toBe('p');
    });
  });

  describe('updateProfile', () => {
    it('updates both limitation and profile fields', async () => {
      // getLimitationByName lookup
      fake.respond('/tool/user-manager/profile/limitation/print', [
        {
          '.id': '*lim1',
          name: 'vip_LIMIT',
          'uptime-limit': '1h',
          'transfer-limit': '1G',
          'rate-limit-rx': '512k',
          'rate-limit-tx': '4M',
        },
      ]);
      // limitation/set
      fake.respond('/tool/user-manager/profile/limitation/set', []);
      // profile/print for updating profile validity + shared-users
      fake.respond('/tool/user-manager/profile/print', [
        { '.id': '*p1', name: 'vip', owner: 'admin', validity: '1h', 'override-shared-users': '1' },
      ]);
      // profile/set
      fake.respond('/tool/user-manager/profile/set', []);
      // getProfile for return value
      fake.respond('/tool/user-manager/profile/profile-limitation/print', [
        { '.id': '*l1', profile: 'vip', limitation: 'vip_LIMIT' },
      ]);

      const profile = await strategy.updateProfile('vip', {
        validity: '2h',
        dataLimit: '2GB',
        rateLimit: '1M/8M',
        sharedUsers: 3,
      });

      expect(profile.name).toBe('vip');

      // Check limitation was updated
      const limSet = fake.lastCallTo('/tool/user-manager/profile/limitation/set');
      expect(limSet).toBeDefined();
      expect(limSet!.params).toContain('=.id=*lim1');
      expect(limSet!.params).toContain('=uptime-limit=2h');
      expect(limSet!.params).toContain('=rate-limit-rx=1M');
      expect(limSet!.params).toContain('=rate-limit-tx=8M');
      // Check transfer-limit contains the formatted bytes
      expect(limSet!.params.some(p => p.startsWith('=transfer-limit='))).toBe(true);

      // Check profile validity and shared-users were updated
      const profSet = fake.lastCallTo('/tool/user-manager/profile/set');
      expect(profSet).toBeDefined();
      expect(profSet!.params).toContain('=.id=*p1');
      expect(profSet!.params).toContain('=validity=2h');
      expect(profSet!.params).toContain('=override-shared-users=3');
    });

    it('updates only limitation when no profile-level fields change', async () => {
      fake.respond('/tool/user-manager/profile/limitation/print', [
        { '.id': '*lim1', name: 'vip_LIMIT', 'uptime-limit': '1h' },
      ]);
      fake.respond('/tool/user-manager/profile/limitation/set', []);
      fake.respond('/tool/user-manager/profile/print', [
        { '.id': '*p1', name: 'vip', owner: 'admin' },
      ]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', [
        { '.id': '*l1', profile: 'vip', limitation: 'vip_LIMIT' },
      ]);

      await strategy.updateProfile('vip', {
        rateLimit: '2M/4M',
      });

      const limSet = fake.lastCallTo('/tool/user-manager/profile/limitation/set');
      expect(limSet).toBeDefined();
      expect(limSet!.params).toContain('=rate-limit-rx=2M');
      expect(limSet!.params).toContain('=rate-limit-tx=4M');

      // profile/set should NOT be called (no validity or sharedUsers)
      const profSet = fake.lastCallTo('/tool/user-manager/profile/set');
      expect(profSet).toBeUndefined();
    });

    it('throws MikrotikNotFoundError when profile does not exist', async () => {
      fake.respond('/tool/user-manager/profile/limitation/print', []);
      fake.respond('/tool/user-manager/profile/print', []);

      await expect(strategy.updateProfile('nope', { validity: '1h' }))
        .rejects.toBeInstanceOf(MikrotikNotFoundError);
    });
  });

  describe('createVoucher', () => {
    it('creates user with =username= (UM v1) and activates profile', async () => {
      fake.respond('/tool/user-manager/user/add', []);
      fake.respond('/tool/user-manager/user/create-and-activate-profile', []);
      fake.respond('/tool/user-manager/user/print', [
        {
          '.id': '*u1',
          username: 'CARD001',
          'actual-profile': 'vip',
          comment: 'mikrotik-voucher-manager',
          disabled: 'false',
          'download-used': '0',
          'upload-used': '0',
          'uptime-used': '0s',
        },
      ]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', []);
      fake.respond('/tool/user-manager/profile/limitation/print', [
        { '.id': '*l', name: 'vip_LIMIT', 'uptime-limit': '1h' },
      ]);

      const voucher = await strategy.createVoucher({
        code: 'CARD001',
        profile: 'vip',
      });

      expect(voucher.code).toBe('CARD001');
      expect(voucher.profile).toBe('vip');

      const userAdd = fake.lastCallTo('/tool/user-manager/user/add');
      expect(userAdd!.params).toContain('=username=CARD001');
      expect(userAdd!.params).toContain('=password=CARD001');
      expect(userAdd!.params).toContain('=customer=admin');

      const activate = fake.lastCallTo('/tool/user-manager/user/create-and-activate-profile');
      expect(activate!.params).toContain('=numbers=CARD001');
      expect(activate!.params).toContain('=profile=vip');
    });

    it('falls back to =name= (UM v2) when =username= is unknown', async () => {
      let addAttempts = 0;
      fake.respond('/tool/user-manager/user/add', (params) => {
        addAttempts++;
        if (addAttempts === 1) {
          // First attempt with =username= — simulate UM v2 "unknown parameter"
          return new Error('unknown parameter');
        }
        // Second attempt with =name= succeeds
        expect(params).toContain('=name=CARD');
        return [];
      });
      fake.respond('/tool/user-manager/user/create-and-activate-profile', []);
      fake.respond('/tool/user-manager/user/print', [
        { '.id': '*u', username: 'CARD', 'actual-profile': 'p', disabled: 'false' },
      ]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', []);
      fake.respond('/tool/user-manager/profile/limitation/print', []);

      const v = await strategy.createVoucher({ code: 'CARD', profile: 'p' });
      expect(v.code).toBe('CARD');
      expect(addAttempts).toBe(2);
    });
  });

  describe('profile limitation fallback chain', () => {
    it('falls back to naming convention when link table is empty', async () => {
      fake.respond('/tool/user-manager/user/print', [
        { '.id': '*u', username: 'C', 'actual-profile': 'pp', disabled: 'false' },
      ]);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', []);
      // The code tries profile/limitation/print first with the fallback naming
      fake.respond('/tool/user-manager/profile/limitation/print', [
        { '.id': '*lim', name: 'pp_LIMIT', 'uptime-limit': '2h', 'transfer-limit': '500M' },
      ]);

      const v = await strategy.getVoucher('C');
      expect(v!.limits.validity).toBe('2h');
      expect(v!.limits.validitySeconds).toBe(7200);
      expect(v!.limits.dataBytes).toBe(500 * 1024 * 1024);
    });

    it('falls back to alt path for limitation lookup', async () => {
      fake.respond('/tool/user-manager/user/print', [
        { '.id': '*u', username: 'C', 'actual-profile': 'pp', disabled: 'false' },
      ]);
      fake.respond(
        '/tool/user-manager/profile/profile-limitation/print',
        new Error('no such command')
      );
      fake.respond('/tool/user-manager/profile-limitation/print', [
        { '.id': '*l', profile: 'pp', limitation: 'custom_lim' },
      ]);
      fake.respond(
        '/tool/user-manager/profile/limitation/print',
        new Error('no such command')
      );
      fake.respond('/tool/user-manager/limitation/print', [
        { '.id': '*lim', name: 'custom_lim', 'uptime-limit': '3h' },
      ]);

      const v = await strategy.getVoucher('C');
      expect(v!.limits.validity).toBe('3h');
    });
  });

  describe('deleteVoucher', () => {
    it('removes sessions and user', async () => {
      fake.respond('/tool/user-manager/user/print', [
        { '.id': '*u', username: 'C', disabled: 'false' },
      ]);
      fake.respond('/tool/user-manager/session/print', [{ '.id': '*s1', user: 'C' }]);
      fake.respond('/tool/user-manager/session/remove', []);
      fake.respond('/tool/user-manager/user/remove', []);

      await strategy.deleteVoucher('C');
      expect(fake.lastCallTo('/tool/user-manager/session/remove')!.params).toContain('=.id=*s1');
      expect(fake.lastCallTo('/tool/user-manager/user/remove')!.params).toContain('=.id=*u');
    });

    it('throws MikrotikNotFoundError when no user exists', async () => {
      fake.respond('/tool/user-manager/user/print', []);
      await expect(strategy.deleteVoucher('X')).rejects.toBeInstanceOf(MikrotikNotFoundError);
    });
  });

  describe('lifecycle operations', () => {
    beforeEach(() => {
      fake.respond('/tool/user-manager/user/print', [
        { '.id': '*u', username: 'C', 'actual-profile': 'p', disabled: 'false' },
      ]);
      fake.respond('/tool/user-manager/user/enable', []);
      fake.respond('/tool/user-manager/user/disable', []);
      fake.respond('/tool/user-manager/user/reset-counters', []);
      fake.respond('/tool/user-manager/user/create-and-activate-profile', []);
      fake.respond('/tool/user-manager/profile/profile-limitation/print', []);
      fake.respond('/tool/user-manager/profile/limitation/print', [
        { '.id': '*lim', name: 'p_LIMIT', 'uptime-limit': '1h' },
      ]);
      fake.respond('/tool/user-manager/profile/limitation/set', []);
    });

    it('enable', async () => {
      await strategy.enableVoucher('C');
      expect(fake.lastCallTo('/tool/user-manager/user/enable')!.params).toContain('=.id=*u');
    });

    it('disable', async () => {
      await strategy.disableVoucher('C');
      expect(fake.lastCallTo('/tool/user-manager/user/disable')!.params).toContain('=.id=*u');
    });

    it('resetUsage tries reset-counters first', async () => {
      await strategy.resetVoucherUsage('C');
      const call = fake.lastCallTo('/tool/user-manager/user/reset-counters');
      expect(call).toBeDefined();
      expect(call!.params).toContain('=.id=*u');
    });

    it('resetUsage falls back to re-activate when reset-counters unsupported', async () => {
      fake.respond(
        '/tool/user-manager/user/reset-counters',
        new Error('no such command')
      );
      await strategy.resetVoucherUsage('C');
      const activate = fake.lastCallTo('/tool/user-manager/user/create-and-activate-profile');
      expect(activate).toBeDefined();
      expect(activate!.params).toContain('=numbers=C');
      expect(activate!.params).toContain('=profile=p');
    });

    it('extend adds seconds to linked limitation uptime-limit', async () => {
      await strategy.extendVoucher('C', '30m');
      const limSet = fake.lastCallTo('/tool/user-manager/profile/limitation/set')!;
      expect(limSet.params).toContain('=.id=*lim');
      // 1h + 30m = 1h30m
      expect(limSet.params).toContain('=uptime-limit=1h30m');
    });
  });
});
