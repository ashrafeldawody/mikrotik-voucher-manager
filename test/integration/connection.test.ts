import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getIntegrationConfig } from './env.js';
import { MikrotikClient } from '../../src/index.js';

const cfg = getIntegrationConfig();
const describeOrSkip = cfg ? describe : describe.skip;

describeOrSkip('integration: connection', () => {
  it('testConnection returns identity and version', async () => {
    const result = await MikrotikClient.testConnection({
      host: cfg!.host,
      port: cfg!.port,
      username: cfg!.username,
      password: cfg!.password,
    });
    expect(result.ok).toBe(true);
    expect(result.identity).toBeDefined();
    expect(result.version).toBeDefined();
  });

  it('client.connect/disconnect lifecycle works', async () => {
    const client = new MikrotikClient({
      host: cfg!.host,
      port: cfg!.port,
      username: cfg!.username,
      password: cfg!.password,
    });
    expect(client.isConnected).toBe(false);
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('system.identity and system.resource return real data', async () => {
    await MikrotikClient.withClient(
      { host: cfg!.host, port: cfg!.port, username: cfg!.username, password: cfg!.password },
      async (client) => {
        const identity = await client.system.identity();
        expect(typeof identity.name).toBe('string');

        const resource = await client.system.resource();
        expect(resource.version).toBeTruthy();
        expect(resource.totalMemory).toBeGreaterThan(0);
      }
    );
  });

  it('detects user-manager version (v1 / v2 / none)', async () => {
    await MikrotikClient.withClient(
      { host: cfg!.host, port: cfg!.port, username: cfg!.username, password: cfg!.password },
      async (client) => {
        const version = await client.system.detectUserManagerVersion();
        expect(['v1', 'v2', 'none']).toContain(version);
      }
    );
  });
});
