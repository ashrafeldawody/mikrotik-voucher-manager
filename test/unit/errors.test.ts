import { describe, it, expect } from 'vitest';
import {
  MikrotikError,
  MikrotikConnectionError,
  MikrotikAuthError,
  MikrotikNotFoundError,
  MikrotikAlreadyExistsError,
  MikrotikProfileNotFoundError,
  MikrotikTimeoutError,
  mapMikrotikError,
} from '../../src/errors.js';

describe('error classes', () => {
  it('MikrotikError instances are Errors', () => {
    const e = new MikrotikError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(MikrotikError);
    expect(e.message).toBe('boom');
    expect(e.name).toBe('MikrotikError');
  });

  it('subclasses preserve instanceof chain', () => {
    const e = new MikrotikConnectionError('dropped');
    expect(e).toBeInstanceOf(MikrotikError);
    expect(e).toBeInstanceOf(MikrotikConnectionError);
    expect(e.name).toBe('MikrotikConnectionError');
  });

  it('preserves cause', () => {
    const inner = new Error('inner');
    const outer = new MikrotikError('outer', inner);
    expect(outer.cause).toBe(inner);
  });
});

describe('mapMikrotikError', () => {
  it('returns the same error if already a MikrotikError', () => {
    const e = new MikrotikError('x');
    expect(mapMikrotikError(e)).toBe(e);
  });

  it('maps auth errors', () => {
    expect(mapMikrotikError(new Error('login failed'))).toBeInstanceOf(MikrotikAuthError);
    expect(mapMikrotikError(new Error('invalid user name or password'))).toBeInstanceOf(
      MikrotikAuthError
    );
    expect(mapMikrotikError(new Error('cannot log in'))).toBeInstanceOf(MikrotikAuthError);
  });

  it('maps profile-not-found errors', () => {
    const e = new Error('input does not match any value of profile');
    expect(mapMikrotikError(e)).toBeInstanceOf(MikrotikProfileNotFoundError);
  });

  it('maps already-exists errors', () => {
    expect(mapMikrotikError(new Error('already have user with this name'))).toBeInstanceOf(
      MikrotikAlreadyExistsError
    );
    expect(mapMikrotikError(new Error('X already exists'))).toBeInstanceOf(
      MikrotikAlreadyExistsError
    );
  });

  it('maps not-found errors', () => {
    expect(mapMikrotikError(new Error('no such item'))).toBeInstanceOf(MikrotikNotFoundError);
    expect(mapMikrotikError(new Error('not found'))).toBeInstanceOf(MikrotikNotFoundError);
  });

  it('maps connection errors', () => {
    expect(mapMikrotikError(new Error('connect ECONNREFUSED'))).toBeInstanceOf(
      MikrotikConnectionError
    );
    expect(mapMikrotikError(new Error('socket closed'))).toBeInstanceOf(MikrotikConnectionError);
    expect(mapMikrotikError(new Error('ETIMEDOUT'))).toBeInstanceOf(MikrotikConnectionError);
  });

  it('maps timeout errors', () => {
    expect(mapMikrotikError(new Error('operation timed out'))).toBeInstanceOf(MikrotikTimeoutError);
  });

  it('falls back to generic MikrotikError', () => {
    const e = mapMikrotikError(new Error('something exotic'));
    expect(e).toBeInstanceOf(MikrotikError);
    expect(e.constructor.name).toBe('MikrotikError');
    expect(e.message).toBe('something exotic');
  });

  it('handles non-Error inputs', () => {
    expect(mapMikrotikError('string error').message).toBe('string error');
    expect(mapMikrotikError({ message: 'obj' }).message).toBe('obj');
    expect(mapMikrotikError(null).message).toBe('Unknown MikroTik error');
    expect(mapMikrotikError(undefined).message).toBe('Unknown MikroTik error');
  });
});
