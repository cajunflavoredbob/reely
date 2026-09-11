import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pinoMock } = vi.hoisted(() => ({ pinoMock: vi.fn() }));

vi.mock('pino', () => ({ default: pinoMock }));

const fakePinoLogger = () => ({
  level: 'info',
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
});

// logger.ts builds its pino instance at import time, so each case needs a
// fresh module registry.
const importLogger = async () => {
  vi.resetModules();
  return import('../../internal/app/reely/logger');
};

describe('logger transport selection', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    pinoMock.mockReset().mockImplementation(() => fakePinoLogger());
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('ships plain NDJSON in production, with no transport', async () => {
    process.env.NODE_ENV = 'production';
    await importLogger();
    expect(pinoMock).toHaveBeenCalledTimes(1);
    expect(pinoMock).toHaveBeenCalledWith({ level: 'info' });
  });

  it('asks for pino-pretty outside production', async () => {
    process.env.NODE_ENV = 'development';
    await importLogger();
    expect(pinoMock).toHaveBeenCalledTimes(1);
    expect(pinoMock).toHaveBeenCalledWith(
      expect.objectContaining({ transport: { target: 'pino-pretty', options: { colorize: true } } }),
    );
  });

  // pino-pretty is a devDependency and is absent from the published image, so
  // pino throws while this module is still being imported. Without the
  // fallback, NODE_ENV=development on the image kills the container at boot
  // with a raw stack and no diagnostic.
  it('falls back to NDJSON when the pretty transport cannot be resolved', async () => {
    process.env.NODE_ENV = 'development';
    pinoMock
      .mockImplementationOnce(() => {
        throw new Error('unable to determine transport target for "pino-pretty"');
      })
      .mockImplementation(() => fakePinoLogger());
    const { logger } = await importLogger();
    expect(pinoMock).toHaveBeenCalledTimes(2);
    expect(pinoMock).toHaveBeenLastCalledWith({ level: 'info' });
    expect(() => logger.info('still logging')).not.toThrow();
  });
});
