/**
 * Public types for mikrotik-voucher-manager
 */

export type MikrotikMode = 'hotspot' | 'usermanager';

/**
 * A duration may be:
 *  - a number of seconds (e.g. 3600)
 *  - a MikroTik-style string (e.g. '1h30m', '2d5h', '45m', '30s')
 */
export type Duration = number | string;

/**
 * A byte size may be:
 *  - a number of bytes (e.g. 1073741824)
 *  - a human-readable string (e.g. '1GB', '500MB', '2G', '100K')
 */
export type ByteSize = number | string;

export interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ReconnectOptions {
  enabled?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface MikrotikClientConfig {
  host: string;
  username: string;
  password: string;
  port?: number;
  tls?: boolean;
  mode?: MikrotikMode;
  timeout?: number;
  reconnect?: ReconnectOptions;
  logger?: Logger;
  /** User Manager "customer" (owner) — defaults to 'admin' */
  customer?: string;
}

export interface Profile {
  name: string;
  mode: MikrotikMode;
  rateLimit: string | null;
  sharedUsers: number;
  validity: string | null;
  validitySeconds: number | null;
  dataLimitBytes: number | null;
  raw: Record<string, string>;
}

export interface CreateProfileInput {
  name: string;
  rateLimit?: string;
  sharedUsers?: number;
  validity?: Duration;
  dataLimit?: ByteSize;
}

export interface UpdateProfileInput {
  rateLimit?: string;
  sharedUsers?: number;
  validity?: Duration;
  dataLimit?: ByteSize;
}

export interface CreateVoucherInput {
  code: string;
  profile: string;
  validity?: Duration;
  dataLimit?: ByteSize;
  comment?: string;
  password?: string;
  bindOnFirstUse?: boolean;
}

export interface VoucherFilter {
  profile?: string;
  active?: boolean;
  disabled?: boolean;
  used?: boolean;
  commentPrefix?: string;
  limit?: number;
  offset?: number;
}

export interface Voucher {
  code: string;
  profile: string;
  mode: MikrotikMode;
  comment: string;
  disabled: boolean;
  password: string | null;
  createdAt: Date | null;
  lastSeen: Date | null;
  callerId: string | null;
  limits: {
    validity: string | null;
    validitySeconds: number | null;
    dataBytes: number | null;
  };
  usage: {
    bytesIn: number;
    bytesOut: number;
    bytesTotal: number;
    uptime: string;
    uptimeSeconds: number;
  };
  isActive: boolean;
  activeSession: ActiveSession | null;
  raw: Record<string, string>;
}

export interface VoucherUsage {
  code: string;
  profile: string;
  mode: MikrotikMode;
  isActive: boolean;
  bytesUsed: number;
  bytesIn: number;
  bytesOut: number;
  bytesLimit: number | null;
  bytesRemaining: number | null;
  dataUsedPercentage: number;
  uptimeUsed: string;
  uptimeUsedSeconds: number;
  limitUptime: string | null;
  limitUptimeSeconds: number | null;
  remainingUptime: string | null;
  remainingUptimeSeconds: number | null;
  timeUsedPercentage: number;
  lastSeen: Date | null;
  callerId: string | null;
  disabled: boolean;
  activeSession: ActiveSession | null;
}

export interface ActiveSession {
  username: string;
  ipAddress: string | null;
  macAddress: string | null;
  uptime: string;
  uptimeSeconds: number;
  loginAt: Date | null;
  bytesIn: number;
  bytesOut: number;
  raw: Record<string, string>;
}

export interface BulkResult<TSuccess, TInput = unknown> {
  total: number;
  succeeded: TSuccess[];
  failed: Array<{ input: TInput; error: Error }>;
}

export interface SystemIdentity {
  name: string;
}

export interface SystemResource {
  version: string;
  uptime: string;
  cpuLoad: number;
  freeMemory: number;
  totalMemory: number;
  boardName: string;
  architectureName: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  identity?: string;
  version?: string;
  error?: string;
}

/**
 * Raw command response from routeros
 */
export type RawResponse = Record<string, string>;
