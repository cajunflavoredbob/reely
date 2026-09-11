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
    // `new URL("plex.local:32400")` parses, reading "plex.local:" as the
    // scheme, so only the protocol check catches the most common way of
    // writing a Plex address.
    [{ servers: [{ url: 'plex.local:32400', token: 'abc123' }] },   ['ServerUrlInvalid']],
    [{ servers: [{ url: 'localhost:32400', token: 'abc123' }] },    ['ServerUrlInvalid']],
    [{ servers: [{ url: 'file:///etc/passwd', token: 'abc123' }] }, ['ServerUrlInvalid']],
    [{ servers: [{ url: 'https://plex.example.com', token: 'abc123' }] }, []],
    [{ rootPath: '/' },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 123 },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 'noslash' },                                      ['ServerBasePathInvalid', 'ServersMustBeArray']],
    // handlers/template.ts drops anything outside its allowlist at request
    // time and serves the page with no prefix, so a rootPath it will not
    // honour has to fail at boot instead.
    [{ rootPath: '/reely' },                                       ['ServersMustBeArray']],
    [{ rootPath: '/reely/beta_2.0-x' },                            ['ServersMustBeArray']],
    [{ rootPath: '/reely/' },                                      ['ServersMustBeArray']],
    [{ rootPath: '/film-auswählen' },                              ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: '/reely+beta' },                                  ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: '/reely/../etc' },                                ['ServerBasePathInvalid', 'ServersMustBeArray']],
    // template.ts strips whitespace before testing, so a value it accepts
    // must not be rejected here.
    [{ rootPath: '/ree ly' },                                      ['ServersMustBeArray']],
    // The env layer always produces a list; a bare string can only come from
    // YAML, where it would fail the consumer's Array.isArray guard and deny
    // the very origin it names.
    [{ allowedOrigins: ['https://example.com'] },                  ['ServersMustBeArray']],
    [{ allowedOrigins: 'https://example.com' },                    ['ServersMustBeArray']],
    [{ allowedOrigins: 123 },                                      ['AllowedOriginsInvalid', 'ServersMustBeArray']],
    [{ allowedOrigins: [123] },                                    ['AllowedOriginsInvalid', 'ServersMustBeArray']],
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

  // The validator mutates in place, and loadConfig caches what it returns.
  it('coerces a scalar allowedOrigins into a one-element list', () => {
    const config: Record<string, unknown> = {
      servers: [{ url: 'http://localhost', token: 'abc123' }],
      allowedOrigins: 'https://example.com',
    };
    expect(normalizeAndValidateConfig(config)).toEqual([]);
    expect(config.allowedOrigins).toEqual(['https://example.com']);
  });

  // The message is printed at boot, where the Plex address is exactly what the
  // redacting logger exists to keep out of pasted logs.
  it('does not echo the configured url back in the invalid-url message', () => {
    const errors = normalizeAndValidateConfig({
      servers: [{ url: 'plex.local:32400', token: 'abc123' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toContain('plex.local');
    expect(errors[0].message).toMatch(/protocol/);
  });
});
