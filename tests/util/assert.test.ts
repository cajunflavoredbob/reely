import { describe, expect, it } from 'vitest';
import {
  ReelyError,
  ReelyUnknownError,
  assert,
  isRecord,
} from '../../internal/app/reely/util/assert';

describe('ReelyError', () => {
  it('is an Error subclass with the class name reflected in `.name`', () => {
    const err = new ReelyError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReelyError);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('ReelyError');
  });

  it('carries an empty message when constructed without one', () => {
    const err = new ReelyError();
    expect(err.message).toBe('');
    expect(err.name).toBe('ReelyError');
  });
});

describe('ReelyUnknownError', () => {
  // It extends Error directly, not ReelyError, and pins its name in a class
  // field rather than inheriting the subclass-name behaviour.
  it('has its name pinned to "ReelyUnknownError"', () => {
    const err = new ReelyUnknownError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReelyUnknownError');
    expect(err.message).toBe('x');
  });
});

describe('assert', () => {
  it('is a no-op when the expression is truthy', () => {
    expect(() => assert(1)).not.toThrow();
    expect(() => assert('ok')).not.toThrow();
    expect(() => assert({})).not.toThrow();
    expect(() => assert([])).not.toThrow();
  });

  it('throws ReelyUnknownError by default when the expression is falsy', () => {
    expect(() => assert(0, 'zero')).toThrow(ReelyUnknownError);
    expect(() => assert(0, 'zero')).toThrow('zero');
  });

  it('throws each of the standard falsy values', () => {
    for (const falsy of [false, 0, '', null, undefined, Number.NaN]) {
      expect(() => assert(falsy)).toThrow(ReelyUnknownError);
    }
  });

  it('throws the supplied ErrorType when provided', () => {
    class CustomErr extends Error {
      name = 'CustomErr';
    }
    expect(() => assert(false, 'msg', CustomErr)).toThrow(CustomErr);
  });
});

describe('isRecord', () => {
  it('is a no-op for plain objects', () => {
    expect(() => isRecord({})).not.toThrow();
    expect(() => isRecord({ a: 1, b: 'x' })).not.toThrow();
  });

  // Arrays are `typeof 'object'` and non-null, so they pass. Pinned because a
  // reader would expect POJO-only.
  it('accepts arrays (typeof object && !== null)', () => {
    expect(() => isRecord([])).not.toThrow();
  });

  it('throws ReelyError on null', () => {
    expect(() => isRecord(null)).toThrow(ReelyError);
    expect(() => isRecord(null, 'config')).toThrow('config must be an object');
  });

  it('throws ReelyError on non-objects', () => {
    expect(() => isRecord(undefined)).toThrow(ReelyError);
    expect(() => isRecord(42)).toThrow(ReelyError);
    expect(() => isRecord('s')).toThrow(ReelyError);
    expect(() => isRecord(true)).toThrow(ReelyError);
  });

  it('uses "value" as the default name in the error message', () => {
    expect(() => isRecord(null)).toThrow('value must be an object');
  });
});
