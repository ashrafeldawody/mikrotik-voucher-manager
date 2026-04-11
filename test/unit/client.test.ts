import { describe, it, expect } from 'vitest';
import { MikrotikClient } from '../../src/client.js';
import { MikrotikValidationError } from '../../src/errors.js';
import type { RawResponse } from '../../src/types.js';

/**
 * These tests mount a MikrotikClient against a scripted in-memory fake of
 * the `routeros` module. They verify mode routing, lifecycle, events, and
 * the withClient / testConnection helpers.
 */

interface FakeSocket {
  connect: () => Promise<void>;
  write: (path: string, params?: string[]) => Promise<RawResponse[]>;
  close: () => void;
}

function makeFakeFactory(behaviour: {
  connect?: () => Promise<void>;
  responses?: Record<string, RawResponse[] | Error>;
}) {
  const calls: Array<{ path: string; params: string[] }> = [];
  let closed = false;
  const fakeInstance: FakeSocket = {
    connect: behaviour.connect ?? (async () => {}),
    write: async (path, params = []) => {
      calls.push({ path, params });
      const r = behaviour.responses?.[path];
      if (r instanceof Error) throw r;
      return r ?? [];
    },
    close: () => {
      closed = true;
    },
  };

  class FakeRouterOs {
    constructor(_opts: unknown) {}
    connect = fakeInstance.connect;
    write = fakeInstance.write;
    close = fakeInstance.close;
  }

  const factory = async () => FakeRouterOs as any;
  return { factory, calls, isClosed: () => closed };
}

describe('MikrotikClient', () => {
  describe('construction validation', () => {
    it('requires host, username, password', () => {
      expect(() => new MikrotikClient({ host: '', username: 'u', password: 'p' })).toThrow(
        MikrotikValidationError
      );
      expect(() => new MikrotikClient({ host: 'h', username: '', password: 'p' })).toThrow(
        MikrotikValidationError
      );
      // password may be empty string (valid for User Manager admin), but not null/undefined
      expect(
        () => new MikrotikClient({ host: 'h', username: 'u', password: undefined as any })
      ).toThrow(MikrotikValidationError);
      expect(() => new MikrotikClient({ host: 'h', username: 'u', password: '' })).not.toThrow();
    });

    it('defaults mode to hotspot', () => {
      const c = new MikrotikClient({ host: 'h', username: 'u', password: 'p' });
      expect(c.mode).toBe('hotspot');
    });

    it('uses usermanager mode when requested', () => {
      const c = new MikrotikClient({
        host: 'h',
        username: 'u',
        password: 'p',
        mode: 'usermanager',
      });
      expect(c.mode).toBe('usermanager');
    });
  });

  describe('connection lifecycle', () => {
    it('connect/disconnect transitions isConnected and fires events', async () => {
      const { factory, isClosed } = makeFakeFactory({});
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );

      const events: string[] = [];
      client.on('connect', () => events.push('connect'));
      client.on('disconnect', () => events.push('disconnect'));

      expect(client.isConnected).toBe(false);
      await client.connect();
      expect(client.isConnected).toBe(true);
      expect(events).toContain('connect');

      await client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(isClosed()).toBe(true);
    });
  });

  describe('sub-API routing', () => {
    it('profiles.list routes through hotspot strategy for hotspot mode', async () => {
      const { factory, calls } = makeFakeFactory({
        responses: {
          '/ip/hotspot/user/profile/print': [
            { '.id': '*1', name: 'default', 'rate-limit': '', 'shared-users': '1' },
          ],
        },
      });
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p', mode: 'hotspot' },
        { routerOsFactory: factory }
      );
      await client.connect();

      const list = await client.profiles.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.mode).toBe('hotspot');
      expect(calls.some((c) => c.path === '/ip/hotspot/user/profile/print')).toBe(true);

      await client.disconnect();
    });

    it('profiles.list routes through user-manager strategy for usermanager mode', async () => {
      const { factory, calls } = makeFakeFactory({
        responses: {
          '/tool/user-manager/profile/print': [
            { '.id': '*1', name: 'p', owner: 'admin' },
          ],
          '/tool/user-manager/profile/profile-limitation/print': [],
          '/tool/user-manager/profile/limitation/print': [
            { '.id': '*l', name: 'p_LIMIT', 'uptime-limit': '1h' },
          ],
        },
      });
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p', mode: 'usermanager' },
        { routerOsFactory: factory }
      );
      await client.connect();

      const list = await client.profiles.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.mode).toBe('usermanager');
      expect(calls.some((c) => c.path === '/tool/user-manager/profile/print')).toBe(true);

      await client.disconnect();
    });
  });

  describe('withClient helper', () => {
    it('opens, runs, and always closes', async () => {
      const { factory, isClosed } = makeFakeFactory({
        responses: {
          '/system/identity/print': [{ name: 'TestRouter' }],
        },
      });

      const result = await MikrotikClient.withClient(
        { host: 'h', username: 'u', password: 'p' },
        async (client) => {
          const identity = await client.system.identity();
          return identity.name;
        },
        { routerOsFactory: factory }
      );

      expect(result).toBe('TestRouter');
      expect(isClosed()).toBe(true);
    });

    it('closes on error', async () => {
      const { factory, isClosed } = makeFakeFactory({});
      await expect(
        MikrotikClient.withClient(
          { host: 'h', username: 'u', password: 'p' },
          async () => {
            throw new Error('boom');
          },
          { routerOsFactory: factory }
        )
      ).rejects.toThrow('boom');
      expect(isClosed()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('returns ok with identity on success', async () => {
      const { factory } = makeFakeFactory({
        responses: {
          '/system/identity/print': [{ name: 'MyRouter' }],
          '/system/resource/print': [{ version: '7.11.2' }],
        },
      });
      const result = await MikrotikClient.testConnection(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );
      expect(result.ok).toBe(true);
      expect(result.identity).toBe('MyRouter');
      expect(result.version).toBe('7.11.2');
    });

    it('returns error on auth failure', async () => {
      const { factory } = makeFakeFactory({
        connect: async () => {
          throw new Error('login failed');
        },
      });
      const result = await MikrotikClient.testConnection(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );
      expect(result.ok).toBe(false);
      expect(result.error?.toLowerCase()).toContain('login failed');
    });
  });

  describe('system.detectUserManagerVersion', () => {
    it('detects v2 when both profile and limitation paths work', async () => {
      const { factory } = makeFakeFactory({
        responses: {
          '/tool/user-manager/profile/print': [],
          '/tool/user-manager/limitation/print': [],
        },
      });
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );
      await client.connect();
      expect(await client.system.detectUserManagerVersion()).toBe('v2');
      await client.disconnect();
    });

    it('detects v1 when limitation path fails', async () => {
      const { factory } = makeFakeFactory({
        responses: {
          '/tool/user-manager/profile/print': [],
          '/tool/user-manager/limitation/print': new Error('no such command'),
        },
      });
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );
      await client.connect();
      expect(await client.system.detectUserManagerVersion()).toBe('v1');
      await client.disconnect();
    });

    it('detects none when profile path fails', async () => {
      const { factory } = makeFakeFactory({
        responses: {
          '/tool/user-manager/profile/print': new Error('no such command'),
        },
      });
      const client = new MikrotikClient(
        { host: 'h', username: 'u', password: 'p' },
        { routerOsFactory: factory }
      );
      await client.connect();
      expect(await client.system.detectUserManagerVersion()).toBe('none');
      await client.disconnect();
    });
  });
});
