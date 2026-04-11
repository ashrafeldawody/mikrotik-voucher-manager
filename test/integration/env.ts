/**
 * Integration test environment loader.
 *
 * Reads MIKROTIK_TEST_* env vars (via node:fs; we don't pull in dotenv to
 * keep deps minimal) and exposes a helper for the test suites.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '..', '.env');

export function loadEnv(): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

export interface IntegrationConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /**
   * User Manager "customer" — internal UM concept, not a login. Always
   * authenticate to the router using the router credentials above; the
   * customer is passed as a parameter on UM commands.
   */
  umCustomer: string;
}

export function getIntegrationConfig(): IntegrationConfig | null {
  const host = process.env['MIKROTIK_TEST_HOST'];
  const username = process.env['MIKROTIK_TEST_USER'];
  const password = process.env['MIKROTIK_TEST_PASS'];
  if (!host || !username || password == null) return null;
  return {
    host,
    port: parseInt(process.env['MIKROTIK_TEST_PORT'] || '8728', 10) || 8728,
    username,
    password,
    umCustomer: process.env['MIKROTIK_TEST_UM_USER'] || 'admin',
  };
}

/**
 * Every integration test creates entities prefixed with this unique value
 * so cleanup can safely purge only entities from this run.
 */
export const TEST_PREFIX = `mvmtest-${Date.now().toString(36)}`;
