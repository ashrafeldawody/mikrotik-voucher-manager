import type {
  Profile,
  Voucher,
  VoucherUsage,
  ActiveSession,
  CreateProfileInput,
  UpdateProfileInput,
  CreateVoucherInput,
  VoucherFilter,
  BulkResult,
  Duration,
  MikrotikMode,
} from '../types.js';
import type { Connection } from '../connection.js';

/**
 * Strategy interface implemented by HotspotStrategy and UserManagerStrategy.
 * The client delegates every sub-API call to the strategy selected by config.mode.
 */
export interface IWifiBackend {
  readonly mode: MikrotikMode;
  readonly connection: Connection;

  // Profiles
  listProfiles(): Promise<Profile[]>;
  getProfile(name: string): Promise<Profile | null>;
  createProfile(input: CreateProfileInput): Promise<Profile>;
  updateProfile(name: string, patch: UpdateProfileInput): Promise<Profile>;
  deleteProfile(name: string): Promise<void>;

  // Vouchers
  createVoucher(input: CreateVoucherInput): Promise<Voucher>;
  createBulkVouchers(inputs: CreateVoucherInput[]): Promise<BulkResult<Voucher, CreateVoucherInput>>;
  getVoucher(code: string): Promise<Voucher | null>;
  listVouchers(filter?: VoucherFilter): Promise<Voucher[]>;
  checkUsage(code: string): Promise<VoucherUsage>;
  deleteVoucher(code: string): Promise<void>;
  deleteBulkVouchers(codes: string[]): Promise<BulkResult<string, string>>;
  enableVoucher(code: string): Promise<void>;
  disableVoucher(code: string): Promise<void>;
  resetVoucherUsage(code: string): Promise<void>;
  extendVoucher(code: string, extra: Duration): Promise<void>;
  changeVoucherProfile(code: string, newProfile: string): Promise<void>;

  // Sessions
  listActiveSessions(): Promise<ActiveSession[]>;
  getActiveSession(username: string): Promise<ActiveSession | null>;
  kickSession(username: string): Promise<void>;
}
