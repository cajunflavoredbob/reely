import { describe, expect, it } from 'vitest';
import { handler } from '../../internal/app/reely/handlers/health';
import { makeReq, makeRes } from '../helpers';

// Smoke tests for the health handler. Tiny on purpose -- the handler
// is two lines: `res.status(200).send('reely is alive')`. The Docker
// HEALTHCHECK polls this; an empty/non-200/missing-body response would
// flip the container to "unhealthy" silently. Pinning behavior here
// catches a future refactor that swaps the body or status by mistake.
// (Audit 13 #338 originally classified this as "deliberately deferred
// -- trivial wrapper". The minimal smoke coverage is added 0.4.50 as
// part of the 0.5.0 close-out so the audit-log status flips from
// untested to minimally-covered.)

describe('handler (/health)', () => {
  it('responds with HTTP 200', () => {
    const req = makeReq();
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sends the "reely is alive" body (used by the Docker HEALTHCHECK)', () => {
    const req = makeReq();
    const res = makeRes();
    handler(req, res);
    expect(res.send).toHaveBeenCalledWith('reely is alive');
  });

  it('returns void (no Promise; the docker healthcheck calls it synchronously)', () => {
    const req = makeReq();
    const res = makeRes();
    const result = handler(req, res);
    expect(result).toBeUndefined();
  });
});
