import { describe, it, expect } from 'vitest';

// No logger mock: the validator is pure and pulls in no transitive pino.
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
    // libraryTypeFilter is retired; unknown server fields are ignored, so an
    // old config carrying it must still validate.
    [{ servers: [{ libraryTypeFilter: ['movie'], url: 'http://localhost', token: 'abc123' }] }, []],
    [{ rootPath: '/' },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 123 },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 'noslash' },                                      ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ basicAuth: 'luke:test' },                                   ['BasicAuthInvalid', 'ServersMustBeArray']],
    [{ basicAuth: {} },                                            ['BasicAuthPasswordInvalid', 'BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'luke' } },                          ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    // An empty password is a string, and passing it is a silent auth bypass.
    [{ basicAuth: { userName: 'luke', password: '' } },            ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: '', password: 'test' } },            ['BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'luke', password: 'test' } },        ['ServersMustBeArray']],
    [{ tlsConfig: '/foo.crt' },                                    ['ServersMustBeArray', 'TlsConfigInvalid']],
    [{ tlsConfig: {} },                                            ['ServersMustBeArray', 'TlsConfigCertFileInvalid', 'TlsConfigKeyFileInvalid']],
    // The env loader coerces via EnvBool, so a non-boolean reaches here only
    // from YAML.
    [{ exposePlexBaseUrl: true },                                  ['ServersMustBeArray']],
    [{ exposePlexBaseUrl: false },                                 ['ServersMustBeArray']],
    [{ exposePlexBaseUrl: 'false' },                               ['ExposePlexBaseUrlInvalid', 'ServersMustBeArray']],
    [{ exposePlexBaseUrl: 1 },                                     ['ExposePlexBaseUrlInvalid', 'ServersMustBeArray']],
  ])('%j → %j', (config, expected) => {
    expect(errNames(config)).toEqual([...expected].sort());
  });
});
