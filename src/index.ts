/**
 * mikrotik-voucher-manager — public entry point
 */

export { MikrotikClient } from './client.js';
export type { MikrotikClientOptions } from './client.js';
export { Connection } from './connection.js';
export type { ConnectionOptions } from './connection.js';

export {
  MikrotikError,
  MikrotikConnectionError,
  MikrotikAuthError,
  MikrotikNotFoundError,
  MikrotikAlreadyExistsError,
  MikrotikProfileNotFoundError,
  MikrotikTimeoutError,
  MikrotikValidationError,
  mapMikrotikError,
} from './errors.js';

export type {
  MikrotikClientConfig,
  MikrotikMode,
  Duration,
  ByteSize,
  Logger,
  ReconnectOptions,
  Profile,
  CreateProfileInput,
  UpdateProfileInput,
  CreateVoucherInput,
  VoucherFilter,
  Voucher,
  VoucherUsage,
  ActiveSession,
  BulkResult,
  SystemIdentity,
  SystemResource,
  ConnectionTestResult,
  RawResponse,
} from './types.js';

export {
  parseDurationToSeconds,
  formatSecondsToDuration,
  normalizeDuration,
  parseByteSize,
  formatBytesForMikrotik,
  parseMikrotikDate,
  normalizeCallerId,
} from './utils/index.js';

export { HotspotStrategy } from './strategies/hotspot.js';
export { UserManagerStrategy } from './strategies/usermanager.js';
export type { IWifiBackend } from './strategies/interface.js';
