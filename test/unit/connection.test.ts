import { describe, it, expect, vi } from 'vitest';
import { Connection } from '../../src/connection.js';
import { MikrotikConnectionError } from '../../src/errors.js';
import type { RawResponse } from '../../src/types.js';

/**
 * These tests exercise Connection's command queue, reconnect policy, and
 * event emission against a scripted fake `routeros` instance.
 */

function makeFactory(script: {
  onConnect?: () => Promise<void>;
  onWrite?: (path: string, params: string[]) => Promise<RawResponse[]>;
  onClose?: () => void;
}) {
  const state = { connects: 0, closes: 0, writes: [] as Array<{ path: string; params: string[] }> };

  class FakeApi {
    constructor(_opts: unknown) {}
    async connect() {
      state.connects += 1;
      if (script.onConnect) await script.onConnect();
    }
    async write(path: string, params: string[] = []) {
      state.writes.push({ path, params });
      if (script.onWrite) return script.onWrite(path, params);
      return [];
    }
    close() {
      state.closes += 1;
      script.onClose?.();
    }
  }

  return {
    factory: async () => FakeApi as any,
    state,
  };
}

describe('Connection', () => {
  it('connects and executes a command', async () => {
    const { factory, state } = makeFactory({
      onWrite: async () => [{ name: 'ok' }],
    });
    const conn = new Connection(
      { host: 'h', username: 'u', password: 'p' },
      { routerOsFactory: factory }
    );
    await conn.connect();
    const result = await conn.exec('/test', []);
    expect(result).toEqual([{ name: 'ok' }]);
    expect(state.connects).toBe(1);
    expect(state.writes).toHaveLength(1);
    await conn.disconnect();
    expect(state.closes).toBe(1);
  });

  it('serializes concurrent exec calls', async () => {
    const order: string[] = [];
    const { factory } = makeFactory({
      onWrite: async (path) => {
        order.push(`start:${path}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${path}`);
        return [];
      },
    });
    const conn = new Connection(
      { host: 'h', username: 'u', password: 'p' },
      { routerOsFactory: factory }
    );
    await conn.connect();
    await Promise.all([conn.exec('/a'), conn.exec('/b'), conn.exec('/c')]);
    expect(order).toEqual([
      'start:/a', 'end:/a',
      'start:/b', 'end:/b',
      'start:/c', 'end:/c',
    ]);
    await conn.disconnect();
  });

  it('rejects queued commands on disconnect()', async () => {
    let releaseFirst: () => void;
    const firstHeld = new Promise<void>((res) => {
      releaseFirst = res;
    });

    const { factory } = makeFactory({
      onWrite: async (path) => {
        if (path === '/first') {
          await firstHeld;
          return [];
        }
        return [];
      },
    });
    const conn = new Connection(
      { host: 'h', username: 'u', password: 'p' },
      { routerOsFactory: factory }
    );
    await conn.connect();

    const p1 = conn.exec('/first');
    const p2 = conn.exec('/second');

    // give the loop a tick so /first is in-flight
    await new Promise((r) => setTimeout(r, 5));

    await conn.disconnect();
    // Release the in-flight command after disconnect
    releaseFirst!();

    // queued /second should be rejected with MikrotikConnectionError
    await expect(p2).rejects.toBeInstanceOf(MikrotikConnectionError);
    // p1 may resolve (the write already happened before close) — we only assert p2
    await p1.catch(() => {});
  });

  it('maps connection-like errors to MikrotikConnectionError', async () => {
    const { factory } = makeFactory({
      onConnect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const conn = new Connection(
      { host: 'h', username: 'u', password: 'p' },
      { routerOsFactory: factory }
    );
    await expect(conn.connect()).rejects.toBeInstanceOf(MikrotikConnectionError);
  });

  it('reconnects after a mid-flight socket drop', async () => {
    vi.useFakeTimers();
    let writeCount = 0;
    let connectCount = 0;

    class FakeApi {
      constructor(_opts: unknown) {}
      async connect() {
        connectCount += 1;
      }
      async write(path: string) {
        writeCount += 1;
        if (path === '/drop') {
          throw new Error('socket closed');
        }
        return [];
      }
      close() {}
    }

    const conn = new Connection(
      {
        host: 'h',
        username: 'u',
        password: 'p',
        reconnect: { enabled: true, maxAttempts: 2, backoffMs: 1 },
      },
      { routerOsFactory: async () => FakeApi as any }
    );

    const events: string[] = [];
    conn.on('disconnect', () => events.push('disconnect'));
    conn.on('reconnecting', () => events.push('reconnecting'));
    conn.on('connect', () => events.push('connect'));

    await conn.connect();

    const firstExec = conn.exec('/drop');
    // wait for the drop to happen
    await expect(firstExec).rejects.toBeInstanceOf(MikrotikConnectionError);

    // advance fake timers so reconnect backoff elapses
    await vi.advanceTimersByTimeAsync(100);

    // ensure reconnect kicked in
    expect(events).toContain('disconnect');
    expect(events).toContain('reconnecting');
    expect(connectCount).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    await conn.disconnect();
  });
});
