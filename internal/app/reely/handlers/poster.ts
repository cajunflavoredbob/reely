import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { logger } from '../logger';
import type { ReelyProvider } from '../providers/types';

// GET /api/poster/:providerIndex/:metadataId/:thumbId, streaming Plex artwork.
// Pins each param to `string`: express 5 types params as `string | string[]`
// for repeating wildcards, but these three are always single segments.
// Exported so the tests type their request stub the same way.
export type PosterParams = { providerIndex: string; metadataId: string; thumbId: string };

export const handler = async (
  req: Request<PosterParams>,
  res: Response,
): Promise<void> => {
  const { providerIndex, metadataId, thumbId } = req.params;
  const providers = res.locals.providers as ReelyProvider[];

  // Validate before coercion: `+providerIndex` accepts Infinity, NaN, and
  // whitespace strings, which only hit the guard below by accident.
  const provider = /^\d+$/.test(providerIndex) ? providers[+providerIndex] : undefined;
  if (!provider) {
    logger.warn(`poster handler: invalid providerIndex ${providerIndex}`);
    res.status(404).send('Provider not found');
    return;
  }

  // Plex ids are integers. Anything else could traverse to a different Plex
  // endpoint once the URL pathname is normalized (/api/poster/0/..%2Fsystem/...).
  if (!/^\d+$/.test(metadataId) || !/^\d+$/.test(thumbId)) {
    logger.warn(
      `poster handler: rejected non-numeric ids metadataId=${metadataId} thumbId=${thumbId}`,
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
    logger.error(`poster handler error: ${(err as Error).message}`);
    if (!res.headersSent) res.status(502).send('Failed to fetch artwork');
  }
};
