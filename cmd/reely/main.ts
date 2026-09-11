import minimist from 'minimist';
import { setLogLevel } from '../../internal/app/reely/logger';
import { loadConfig } from '../../internal/app/reely/config/main';
import { getVersion } from '../../internal/app/reely/version';
import { Application, ProviderUnavailableError, describeError } from '../../internal/app/reely/app';
import { logger } from '../../internal/app/reely/logger';
import { flushPendingSaves } from '../../internal/app/reely/roomStore';
import { triageConfigErrors } from './boot';
import type { Config } from '../../types/reely';
import type { ReelyError } from '../../internal/app/reely/util/assert';

// Bounds the flush below: if the disk is wedged, exit anyway so the supervisor
// can restart us.
const UNCAUGHT_FLUSH_TIMEOUT_MS = 1500;

// Last-resort handlers. Logging goes through the redacting logger so a stray
// stack can't leak the Plex token.
//
// uncaughtException leaves the process undefined per Node's contract, so flush
// the room-save debounce queue (a swipe in the 2s window would be lost) and
// exit for the supervisor to restart.
//
// unhandledRejection only logs: every async path that matters wraps its own
// errors, so a rejection reaching here is a bug in a non-critical path and
// killing the server does more damage. Override with
// NODE_OPTIONS='--unhandled-rejections=strict'.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${String(reason)}`);
});
process.on('uncaughtException', (err) => {
  logger.fatal(`Uncaught exception: ${String(err)}`);
  // The flush and the watchdog race; whichever loses is a no-op.
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    process.exit(1);
  };
  // unref() so the watchdog can't keep the process alive when the flush wins.
  setTimeout(exitOnce, UNCAUGHT_FLUSH_TIMEOUT_MS).unref();
  flushPendingSaves().finally(exitOnce);
});

(async () => {
  const flags = minimist(process.argv.slice(2), { alias: { v: 'version' } });

  if (flags.version) {
    // Must land on stdout for scripting; the pino logger uses another sink.
    // biome-ignore lint/suspicious/noConsole: CLI version output.
    console.log(`reely ${await getVersion()}`);
    process.exit(0);
  }

  // Trimmed, and empty means unset: loadConfig's `?? join(cwd, 'config.yaml')`
  // treats '' as an explicit path, so `CONFIG_PATH=` in an .env or a compose
  // `CONFIG_PATH: ""` would silently skip a mounted config.yaml and boot on
  // defaults. Every other env var goes through the same rule.
  const configPathRaw: unknown = flags.config ?? process.env.CONFIG_PATH;
  const CONFIG_PATH: string | undefined =
    typeof configPathRaw === 'string' && configPathRaw.trim() !== ''
      ? configPathRaw.trim()
      : undefined;

  // loadConfig throws on malformed YAML, permission errors, a scheme-less
  // PLEX_URL, or an empty Docker secret. Without this catch they reach the
  // unhandledRejection handler above, which only logs, leaving the process
  // alive with no config.
  let config: Config;
  let errors: ReelyError[];
  try {
    [config, errors] = await loadConfig(CONFIG_PATH);
  } catch (err) {
    logger.fatal(`Failed to load config: ${String(err)}`);
    process.exit(1);
  }

  const verdict = triageConfigErrors(errors);
  if (verdict === 'unconfigured') {
    logger.error(
      'reely is not configured -- no Plex server. Set the PLEX_URL and ' +
      'PLEX_TOKEN environment variables and restart the container.',
    );
  } else if (verdict === 'fatal') {
    logger.fatal(
      `Found configuration errors: ${errors.map((e) => `\n - ${e.name} - ${e.message}`).join('')}`,
    );
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  logger.info(`reely ${await getVersion()}`);
  // Dumping the whole config is only safe because registerRedactions() ran in
  // loadConfig: the Plex token, URL, and basicAuth password are masked here.
  logger.debug(`Config: ${JSON.stringify(config, null, 2)}`);

  // SIGTERM is what `docker stop` sends, so both signals need the abort path.
  const abortController = new AbortController();
  const shutdown = (sig: string) => {
    logger.info(`${sig} received. Shutting down.`);
    abortController.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const app = Application(config, abortController.signal);
    // statusCode resolves undefined on a clean shutdown -> exit 0.
    const exitCode = await app.statusCode;
    process.exit(exitCode ?? 0);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      logger.fatal(describeError(err));
    } else {
      logger.fatal(`Unexpected error: ${describeError(err)}`);
    }
    process.exit(1);
  }
})().catch((err) => {
  // Boot itself is async, and an unwrapped rejection here (getVersion failing
  // to read VERSION when the process was started from another directory, say)
  // would otherwise fall to the log-only unhandledRejection handler above and
  // exit 0 without ever listening.
  logger.fatal(`Startup failed: ${describeError(err)}`);
  process.exit(1);
});
