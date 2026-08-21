import { describe, expect, it } from 'vitest';
import { handler } from '../../internal/app/reely/handlers/health';
import { makeReq, makeRes } from '../helpers';

// The Docker HEALTHCHECK polls this, so a changed status or body silently
// flips the container to unhealthy.

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
