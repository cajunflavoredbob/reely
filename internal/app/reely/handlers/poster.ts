import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { logger } from '../logger';
import type { ReelyProvider } from '../providers/types';

// GET /api/poster/:providerIndex/:metadataId/:thumbId, streaming Plex artwork.
// Pins each param to `string`: express 5 types params as `string | string[]`
// for repeating wildcards, but these three are always single segments.
// Exported so the tests type their request stub the same way.
export type PosterParams = { providerIndex: string; metadataId: string; thumbId: string };

// Express matches `:param` as [^/]+, so a segment is bounded only by Node's
// 16KB header limit. Plex ratingKeys are short integers, so cap the length
// before the shape check and clip whatever still reaches the log: otherwise an
// unauthenticated request writes its own ~15KB payload into the operator's log
// on every rejection.
const MAX_ID_LENGTH = 32;

const isPlexId = (value: string): boolean =>
  value.length <= MAX_ID_LENGTH && /^\d+$/.test(value);

const clipForLog = (value: string): string =>
  value.length > MAX_ID_LENGTH ? `${value.slice(0, MAX_ID_LENGTH)}...` : value;

export const handler = async (
  req: Request<PosterParams>,
  res: Response,
): Promise<void> => {
  const { providerIndex, metadataId, thumbId } = req.params;
  const providers = res.locals.providers as ReelyProvider[];

  // Validate before coercion: `+providerIndex` accepts Infinity, NaN, and
  // whitespace strings, which only hit the guard below by accident.
  const provider = isPlexId(providerIndex) ? providers[+providerIndex] : undefined;
  if (!provider) {
    logger.warn(`poster handler: invalid providerIndex ${clipForLog(providerIndex)}`);
    res.status(404).send('Provider not found');
    return;
  }

  // Plex ids are integers. Anything else could traverse to a different Plex
  // endpoint once the URL pathname is normalized (/api/poster/0/..%2Fsystem/...).
  if (!isPlexId(metadataId) || !isPlexId(thumbId)) {
    logger.warn(
      `poster handler: rejected non-numeric ids metadataId=${clipForLog(metadataId)} ` +
        `thumbId=${clipForLog(thumbId)}`,
    );
    res.status(400).send('Invalid media id');
    return;
  }

  // Without this the proxy keeps pulling bytes into a dead response after the
  // browser disconnects. Also fires on normal completion, where it is a no-op.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  try {
    const [readableStream, headers] = await provider.getArtwork(
      `${metadataId}/${thumbId}`,
      abort.signal,
    );

    const contentType = headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    const contentLength = headers.get('content-length');
    if (contentLength) res.setHeader('content-length', contentLength);

    // Node and DOM ReadableStream typedefs are compatible at runtime but their
    // declared shapes disagree. Also noted on ReelyProvider.getArtwork.
    // biome-ignore lint/suspicious/noExplicitAny: Node vs Web ReadableStream shape mismatch.
    const nodeStream = Readable.fromWeb(readableStream as any);
    // A mid-stream error (including the abort above) would otherwise be an
    // unhandled 'error' event.
    nodeStream.on('error', (err: Error) => {
      logger.warn(`poster stream interrupted: ${err.message}`);
      res.destroy();
    });
    nodeStream.pipe(res);
  } catch (err) {
    // A client that navigates away before the upstream headers arrive aborts
    // the fetch here, which is ordinary browsing, not a server error. The
    // mid-stream half of the same disconnect already lands on the WARN path
    // above; without this the pre-headers half files an ERROR and tries to
    // answer a socket that is already gone.
    if (abort.signal.aborted) {
      logger.warn(`poster fetch aborted by client: ${(err as Error).message}`);
      return;
    }
    logger.error(`poster handler error: ${(err as Error).message}`);
    if (!res.headersSent) res.status(502).send('Failed to fetch artwork');
  }
};
