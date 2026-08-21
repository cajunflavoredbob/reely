import { isRecord, type ReelyError } from '../util/assert';
import {
  BasicAuthInvalid,
  BasicAuthPasswordInvalid,
  BasicAuthUserNameInvalid,
  ConfigMustBeRecord,
  ExposePlexBaseUrlInvalid,
  HostNameMustBeString,
  LogLevelInvalid,
  PortMustBeNumber,
  ServerBasePathInvalid,
  ServerLibraryTitleFilterInvalid,
  ServerMustBeRecord,
  ServersMustBeArray,
  ServersMustNotBeEmpty,
  ServerTokenMustBeString,
  ServerTypeInvalid,
  ServerUrlInvalid,
  ServerUrlMustBeString,
  TlsConfigCertFileInvalid,
  TlsConfigInvalid,
  TlsConfigKeyFileInvalid,
} from './errors';

// Mapped to pino levels in logger.ts.
const VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];

// The `value is string` predicate narrows at the call site, so follow-on logic
// (URL parse, length, startsWith) sees a typed string.
const requireString = (
  value: unknown,
  errors: ReelyError[],
  ErrorClass: new (msg?: string) => ReelyError,
  message: string,
): value is string => {
  if (typeof value !== 'string') {
    errors.push(new ErrorClass(message));
    return false;
  }
  return true;
};

// Mutates `value` IN PLACE (port to number, logLevel uppercased) and returns
// the validation errors. The mutation is load-bearing: loadConfig caches the
// mutated object, and YAML supplying `port: "8000"` or `logLevel: info`
// depends on it.
export const normalizeAndValidateConfig = (
  value: unknown,
): ReelyError[] => {
  const errors: ReelyError[] = [];

  try {
    isRecord(value, 'config', ConfigMustBeRecord);

    if (value.hostname) {
      requireString(value.hostname, errors, HostNameMustBeString, 'hostname must be a string');
    }

    if (value.port !== undefined) {
      if (typeof value.port === 'string') {
        value.port = Number(value.port);
      }

      if (
        Number.isNaN(value.port) ||
        !Number.isInteger(value.port) ||
        (value.port as number) < 1 ||
        (value.port as number) > 65535
      ) {
        errors.push(new PortMustBeNumber('Port must be an integer between 1 and 65535'));
      }
    }

    if (value.logLevel) {
      if (typeof value.logLevel === 'string') {
        value.logLevel = value.logLevel.toUpperCase();

        if (!VALID_LOG_LEVELS.includes(value.logLevel as string)) {
          errors.push(
            new LogLevelInvalid(
              `logLevel must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
            ),
          );
        }
      } else {
        errors.push(new LogLevelInvalid('logLevel must be a string'));
      }
    }

    if (!Array.isArray(value.servers)) {
      errors.push(new ServersMustBeArray('servers must be an Array'));
    } else if (value.servers.length === 0) {
      errors.push(
        new ServersMustNotBeEmpty('At least one server must be configured'),
      );
    } else {
      for (const server of value.servers) {
        try {
          isRecord(server, 'server', ServerMustBeRecord);

          if (server.type) {
            if (server.type !== 'plex') {
              errors.push(
                new ServerTypeInvalid(
                  `"plex" is the only valid server type. Got "${server.type}"`,
                ),
              );
            }
          }

          if (requireString(server.url, errors, ServerUrlMustBeString, 'a server url must be specified')) {
            // Parse only. Redaction registration lives in config/redact.ts so
            // this stays a pure (unknown) -> ReelyError[].
            try {
              new URL(server.url);
            } catch {
              errors.push(new ServerUrlInvalid(
                `"${server.url}" is not a valid URL. Include the protocol, e.g. http://${server.url}`,
              ));
            }
          }

          if (!requireString(server.token, errors, ServerTokenMustBeString, 'a server token must be specified')) {
            // already pushed
          } else if (server.token.length === 0) {
            errors.push(new ServerTokenMustBeString('a server token must be specified'));
          }

          if (server.libraryTitleFilter) {
            if (!Array.isArray(server.libraryTitleFilter)) {
              errors.push(
                new ServerLibraryTitleFilterInvalid(
                  'libraryTitleFilter must be a list of strings',
                ),
              );
            } else {
              for (const libraryTitle of server.libraryTitleFilter) {
                requireString(
                  libraryTitle,
                  errors,
                  ServerLibraryTitleFilterInvalid,
                  'libraryTitleFilter must be a list of strings',
                );
              }
            }
          }

        } catch (err) {
          errors.push(err as ReelyError);
        }
      }
    }

    if (value.rootPath) {
      if (requireString(value.rootPath, errors, ServerBasePathInvalid, 'rootPath must be a string')) {
        if (value.rootPath === '/') {
          errors.push(new ServerBasePathInvalid('rootPath must not be "/"'));
        } else if (!value.rootPath.startsWith('/')) {
          errors.push(new ServerBasePathInvalid('rootPath must start with "/"'));
        }
      }
    }

    // EnvBool has already coerced env strings, so a non-boolean here came from
    // YAML. Reject `1` / `"true"` rather than let an operator believe they
    // disabled exposure when they didn't.
    if (value.exposePlexBaseUrl !== undefined && typeof value.exposePlexBaseUrl !== 'boolean') {
      errors.push(
        new ExposePlexBaseUrlInvalid('exposePlexBaseUrl must be a boolean'),
      );
    }

    if (value.basicAuth) {
      try {
        isRecord(value.basicAuth, 'basicAuth', BasicAuthInvalid);

        // Must be non-empty: an empty password passes the type check and boots
        // the app "protected" by a guessable base64("user:").
        if (requireString(value.basicAuth.userName, errors, BasicAuthUserNameInvalid, 'basicAuth.userName must be a non-empty string')
            && value.basicAuth.userName === '') {
          errors.push(new BasicAuthUserNameInvalid('basicAuth.userName must be a non-empty string'));
        }
        if (requireString(value.basicAuth.password, errors, BasicAuthPasswordInvalid, 'basicAuth.password must be a non-empty string')
            && value.basicAuth.password === '') {
          errors.push(new BasicAuthPasswordInvalid('basicAuth.password must be a non-empty string'));
        }
      } catch (err) {
        errors.push(err as ReelyError);
      }
    }

    if (value.tlsConfig) {
      try {
        isRecord(value.tlsConfig, 'tlsConfig', TlsConfigInvalid);
        requireString(value.tlsConfig.certFile, errors, TlsConfigCertFileInvalid, 'tlsConfig.certFile must be a string');
        requireString(value.tlsConfig.keyFile, errors, TlsConfigKeyFileInvalid, 'tlsConfig.keyFile must be a string');
      } catch (err) {
        errors.push(err as ReelyError);
      }
    }
  } catch (err) {
    errors.push(err as ReelyError);
  }

  return errors;
};
