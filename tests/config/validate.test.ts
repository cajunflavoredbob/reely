import { describe, it, expect } from 'vitest';

// Logger mock dropped in 0.4.16: validate.ts no longer imports the
// logger (redaction registration moved to config/redact.ts -- audit
// 12 #237 + #276). The validator is a pure (unknown) -> ReelyError[]
// with no transitive pino import, so the worker-thread guard the
// mock used to provide is no longer needed here.
import { normalizeAndValidateConfig } from '../../internal/app/reely/config/validate';

const errNames = (config: unknown): string[] =>
  normalizeAndValidateConfig(config).map((e) => e.name).sort();

describe('normalizeAndValidateConfig', () => {
  it.each<[unknown, string[]]>([
    [undefined,                                                    ['ConfigMustBeRecord']],
    [{},                                                           ['ServersMustBeArray']],
    [{ hostname: 123 },                                            ['HostNameMustBeString', 'ServersMustBeArray']],
    [{ port: '123' },                                              ['ServersMustBeArray']],
    [{ port: 'abc' },                                              ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ port: 123 },                                                ['ServersMustBeArray']],
    [{ port: 0 },                                                  ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ port: 65536 },                                              ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ logLevel: 'debug' },                                        ['ServersMustBeArray']],
    [{ logLevel: 'not a level' },                                  ['LogLevelInvalid', 'ServersMustBeArray']],
    [{ servers: 123 },                                             ['ServersMustBeArray']],
    [{ servers: [] },                                              ['ServersMustNotBeEmpty']],
    [{ servers: [undefined] },                                     ['ServerMustBeRecord']],
    [{ servers: [{}] },                                            ['ServerTokenMustBeString', 'ServerUrlMustBeString']],
    [{ servers: [{ url: 'localhost' }] },                          ['ServerTokenMustBeString', 'ServerUrlInvalid']],
    [{ servers: [{ url: 'localhost', token: '' }] },               ['ServerTokenMustBeString', 'ServerUrlInvalid']],
    [{ servers: [{ url: 'localhost', token: 'abc123' }] },         ['ServerUrlInvalid']],
    [{ servers: [{ url: 'http://localhost', token: 'abc123' }] },  []],
    [{ servers: [{ type: 'jellyfin', url: 'http://localhost', token: 'abc123' }] }, ['ServerTypeInvalid']],
    [{ servers: [{ libraryTitleFilter: 123, url: 'http://localhost', token: 'abc123' }] },     ['ServerLibraryTitleFilterInvalid']],
    [{ servers: [{ libraryTitleFilter: ['Movies'], url: 'http://localhost', token: 'abc123' }] }, []],
    // libraryTypeFilter dropped in 0.4.1 (movies-only). An old config with
    // the field is silently ignored -- the validator doesn't error on unknown
    // server fields, so the line below must NOT produce a validation error.
    [{ servers: [{ libraryTypeFilter: ['movie'], url: 'http://localhost', token: 'abc123' }] }, []],
    [{ rootPath: '/' },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 123 },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 'noslash' },                                      ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ basicAuth: 'luke:test' },                                   ['BasicAuthInvalid', 'ServersMustBeArray']],
    [{ basicAuth: {} },                                            ['BasicAuthPasswordInvalid', 'BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'luke' } },                          ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    // #57: an empty password used to pass (it is a string) -> silent auth bypass.
    [{ basicAuth: { userName: 'luke', password: '' } },            ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: '', password: 'test' } },            ['BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'luke', password: 'test' } },        ['ServersMustBeArray']],
    [{ tlsConfig: '/foo.crt' },                                    ['ServersMustBeArray', 'TlsConfigInvalid']],
    [{ tlsConfig: {} },                                            ['ServersMustBeArray', 'TlsConfigCertFileInvalid', 'TlsConfigKeyFileInvalid']],
    // 0.4.15 EXPOSE_PLEX_BASE_URL opt-out: must be a boolean when present.
    // The env loader coerces strings via EnvBool, so a non-boolean lands
    // here only from YAML (`exposePlexBaseUrl: 1` parses as number).
    [{ exposePlexBaseUrl: true },                                  ['ServersMustBeArray']],
    [{ exposePlexBaseUrl: false },                                 ['ServersMustBeArray']],
    [{ exposePlexBaseUrl: 'false' },                               ['ExposePlexBaseUrlInvalid', 'ServersMustBeArray']],
    [{ exposePlexBaseUrl: 1 },                                     ['ExposePlexBaseUrlInvalid', 'ServersMustBeArray']],
  ])('%j → %j', (config, expected) => {
    expect(errNames(config)).toEqual([...expected].sort());
  });
});
