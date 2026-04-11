# mikrotik-voucher-manager

Advanced MikroTik WiFi voucher manager supporting **Hotspot** and **User Manager** backends through a single unified TypeScript client.

- Works against RouterOS 6.x (User Manager v1) and 7.x (User Manager v2)
- Create, list, update, and delete profiles and vouchers
- Check usage, enable/disable, extend, reset, change profile
- Kick active sessions
- Persistent, auto-reconnecting connection with command serialization
- Strongly typed — full TypeScript definitions
- Typed error classes, not string sniffing
- Tested: 89 unit tests (fully mocked) + 32 integration tests (real router)

## Install

```bash
pnpm add mikrotik-voucher-manager
# or
npm install mikrotik-voucher-manager
```

Requires Node 18+.

## Quick start

```ts
import { MikrotikClient } from 'mikrotik-voucher-manager';

const client = new MikrotikClient({
  host: '192.168.88.1',
  username: 'admin',
  password: 'secret',
  mode: 'hotspot', // or 'usermanager'
});

await client.connect();

// Create a profile
await client.profiles.create({
  name: 'vip',
  rateLimit: '10M/20M',
  sharedUsers: 1,
});

// Create a voucher
const voucher = await client.vouchers.create({
  code: 'CARD-001',
  profile: 'vip',
  validity: '1h',
  dataLimit: '1GB',
});

// Check usage
const usage = await client.vouchers.checkUsage('CARD-001');
console.log(`${usage.dataUsedPercentage}% of data used`);

await client.disconnect();
```

### One-shot helper

For scripts that run a few commands and exit:

```ts
await MikrotikClient.withClient(
  { host: '192.168.88.1', username: 'admin', password: 'secret' },
  async (client) => {
    const profiles = await client.profiles.list();
    console.log(profiles);
  }
);
// connection is closed automatically, even if fn throws
```

### Connection test

```ts
const result = await MikrotikClient.testConnection({
  host: '192.168.88.1',
  username: 'admin',
  password: 'secret',
});
// { ok: true, identity: 'MyRouter', version: '7.11.2' }
```

## Modes

Choose the backend with the `mode` option:

- **`hotspot`** — uses `/ip/hotspot/*`. Vouchers are users in the hotspot server with limits stored directly on the user record.
- **`usermanager`** — uses `/tool/user-manager/*`. Vouchers are RADIUS users with limits stored on a linked limitation.

The public API is identical for both modes — you write the same code and the library translates it to the right RouterOS commands behind the scenes.

## API

### `new MikrotikClient(config, options?)`

Config:

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | `string` | *required* | Router IP or hostname |
| `username` | `string` | *required* | RouterOS login |
| `password` | `string` | *required* | RouterOS password (may be empty) |
| `port` | `number` | `8728` | API port |
| `mode` | `'hotspot' \| 'usermanager'` | `'hotspot'` | |
| `timeout` | `number` | `10000` | Socket timeout (ms) |
| `customer` | `string` | `'admin'` | User Manager customer (UM mode only) |
| `logger` | `Logger` | silent | `{ log, warn, error }` |
| `reconnect` | `ReconnectOptions` | see below | |

Reconnect options:

```ts
{
  enabled: true,          // default true
  maxAttempts: 5,
  backoffMs: 1000,        // exponential backoff base
  maxBackoffMs: 30_000,
}
```

### `client.profiles`

```ts
client.profiles.list(): Promise<Profile[]>
client.profiles.get(name): Promise<Profile | null>
client.profiles.create(input): Promise<Profile>
client.profiles.update(name, patch): Promise<Profile>
client.profiles.delete(name): Promise<void>
```

### `client.vouchers`

```ts
client.vouchers.create(input): Promise<Voucher>
client.vouchers.createBulk(inputs): Promise<BulkResult<Voucher>>
client.vouchers.get(code): Promise<Voucher | null>
client.vouchers.list(filter?): Promise<Voucher[]>
client.vouchers.checkUsage(code): Promise<VoucherUsage>
client.vouchers.delete(code): Promise<void>
client.vouchers.deleteBulk(codes): Promise<BulkResult<string>>
client.vouchers.enable(code): Promise<void>
client.vouchers.disable(code): Promise<void>
client.vouchers.resetUsage(code): Promise<void>
client.vouchers.extend(code, extra): Promise<void>
client.vouchers.changeProfile(code, newProfile): Promise<void>
```

Voucher filters:

```ts
{
  profile?: string;
  active?: boolean;        // currently connected
  disabled?: boolean;
  used?: boolean;          // has any usage recorded
  commentPrefix?: string;
  limit?: number;
  offset?: number;
}
```

### `client.sessions`

```ts
client.sessions.list(): Promise<ActiveSession[]>
client.sessions.get(username): Promise<ActiveSession | null>
client.sessions.kick(username): Promise<void>   // force disconnect
```

### `client.system`

```ts
client.system.identity(): Promise<{ name: string }>
client.system.resource(): Promise<SystemResource>
client.system.detectUserManagerVersion(): Promise<'v1' | 'v2' | 'none'>
```

### `client.raw` — escape hatch

For any RouterOS command not wrapped by the client:

```ts
const rows = await client.raw.exec('/ip/hotspot/active/print', []);
```

### Events

The client is an `EventEmitter`:

```ts
client.on('connect', () => {});
client.on('disconnect', (reason) => {});
client.on('reconnecting', (attempt) => {});
client.on('error', (err) => {});
```

## Errors

All errors thrown by the client inherit from `MikrotikError`:

- `MikrotikConnectionError` — socket drop, timeout, unreachable host
- `MikrotikAuthError` — login failed, wrong credentials
- `MikrotikNotFoundError` — voucher/profile/session not found
- `MikrotikAlreadyExistsError` — create call conflicts with existing entity
- `MikrotikProfileNotFoundError` — voucher create references unknown profile
- `MikrotikTimeoutError` — operation timed out
- `MikrotikValidationError` — invalid input to the client

```ts
import { MikrotikNotFoundError } from 'mikrotik-voucher-manager';

try {
  await client.vouchers.delete('UNKNOWN');
} catch (err) {
  if (err instanceof MikrotikNotFoundError) {
    // ...
  }
}
```

## Units: `Duration` and `ByteSize`

Fields that accept durations (`validity`, `extend`) take either:
- a number of seconds: `3600`
- a MikroTik string: `'1h'`, `'30m'`, `'1h30m'`, `'2d5h'`, `'1w'`

Fields that accept byte sizes (`dataLimit`) take either:
- a number of bytes: `1073741824`
- a human string: `'1GB'`, `'500MB'`, `'2G'`, `'100K'`

## Testing

### Unit tests (default)

```bash
pnpm test
pnpm test:coverage
```

Uses [vitest](https://vitest.dev) and a `FakeConnection` double — no real router required. Runs in CI on every push.

### Integration tests (opt-in, real router)

```bash
# Copy .env.example to .env and fill in your router
cp .env.example .env

pnpm test:integration
```

The suite is skipped automatically if `MIKROTIK_TEST_HOST` etc. are not set. Every integration test creates entities with a unique test-run prefix (`mvmtest-*`) and the suite cleans up after itself.

Verified against:
- RouterOS 6.47.9 (long-term) + User Manager v1

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build    # produces dist/ with CJS + ESM + .d.ts
```

## License

MIT
