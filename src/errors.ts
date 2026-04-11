/**
 * Typed error classes for mikrotik-voucher-manager.
 *
 * Consumers can check instanceof these classes to handle specific failure modes
 * rather than string-matching error messages.
 */

export class MikrotikError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MikrotikError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MikrotikConnectionError extends MikrotikError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikConnectionError';
  }
}

export class MikrotikAuthError extends MikrotikError {
  constructor(message = 'Authentication failed', cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikAuthError';
  }
}

export class MikrotikNotFoundError extends MikrotikError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikNotFoundError';
  }
}

export class MikrotikAlreadyExistsError extends MikrotikError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikAlreadyExistsError';
  }
}

export class MikrotikProfileNotFoundError extends MikrotikError {
  constructor(message = 'Profile not found', cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikProfileNotFoundError';
  }
}

export class MikrotikTimeoutError extends MikrotikError {
  constructor(message = 'Operation timed out', cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikTimeoutError';
  }
}

export class MikrotikValidationError extends MikrotikError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'MikrotikValidationError';
  }
}

/**
 * Map a raw error (from routeros or anywhere else) to a typed MikrotikError.
 * Preserves the original as `cause`.
 */
export function mapMikrotikError(error: unknown): MikrotikError {
  if (error instanceof MikrotikError) {
    return error;
  }

  const rawMessage = extractMessage(error);
  const msg = rawMessage.toLowerCase();

  if (
    msg.includes('login failed') ||
    msg.includes('invalid user name or password') ||
    msg.includes('cannot log in')
  ) {
    return new MikrotikAuthError(rawMessage, error);
  }

  if (msg.includes('input does not match any value of profile')) {
    return new MikrotikProfileNotFoundError(rawMessage, error);
  }

  if (msg.includes('already have') || msg.includes('already exists')) {
    return new MikrotikAlreadyExistsError(rawMessage, error);
  }

  if (
    msg.includes('no such item') ||
    msg.includes('not found') ||
    msg.includes('does not exist')
  ) {
    return new MikrotikNotFoundError(rawMessage, error);
  }

  if (
    msg.includes('connect') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('ehostunreach') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('closed')
  ) {
    return new MikrotikConnectionError(rawMessage, error);
  }

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return new MikrotikTimeoutError(rawMessage, error);
  }

  return new MikrotikError(rawMessage || 'Unknown MikroTik error', error);
}

function extractMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
