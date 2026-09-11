import { describe, expect, it } from 'vitest';
import { triageConfigErrors } from '../../cmd/reely/boot';
import { ReelyError } from '../../internal/app/reely/util/assert';

// loadConfig returns real ReelyError subclasses; only `name` is read here.
const makeError = (name: string): ReelyError => {
  const err = new ReelyError(`${name} message`);
  err.name = name;
  return err;
};

describe('triageConfigErrors', () => {
  it('is ok with no errors', () => {
    expect(triageConfigErrors([])).toBe('ok');
  });

  it('boots unconfigured when the only error is a missing server', () => {
    expect(triageConfigErrors([makeError('ServersMustNotBeEmpty')])).toBe('unconfigured');
  });

  // A misconfigured config must never partially start: the bad fields would
  // ride into a later reconfiguration.
  it('is fatal when another error rides along with the missing server', () => {
    const errors = [makeError('ServersMustNotBeEmpty'), makeError('PortInvalid')];
    expect(triageConfigErrors(errors)).toBe('fatal');
  });

  it('is fatal for any single non-server error', () => {
    expect(triageConfigErrors([makeError('PortInvalid')])).toBe('fatal');
  });
});
