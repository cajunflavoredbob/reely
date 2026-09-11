import type { ReelyError } from '../../internal/app/reely/util/assert';

// Verdicts for the error list loadConfig returns alongside the config.
export type ConfigVerdict = 'ok' | 'unconfigured' | 'fatal';

// Split out of main.ts because nothing can import main.ts without running the
// boot IIFE, which left this branch untestable.
//
// ServersMustNotBeEmpty ALONE boots unconfigured (a notice replaces the SPA
// shell). Any other error is fatal even alongside it: a misconfigured config
// must never partially start, since the bad fields would ride into a later
// reconfiguration.
export const triageConfigErrors = (errors: ReelyError[]): ConfigVerdict => {
  if (errors.length === 0) return 'ok';
  if (errors.length === 1 && errors[0].name === 'ServersMustNotBeEmpty') return 'unconfigured';
  return 'fatal';
};
