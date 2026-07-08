import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { logger } from '../logger';
import type { ReelyProvider } from '../providers/types';

// Route: GET /api/poster/:providerIndex/:metadataId/:thumbId
// Proxies and transcodes artwork from Plex, streaming the response body directly.
export const handler = async (req: Request, res: Response): Promise<void> => {
  const { providerIndex, metadataId, thumbId } = req.params;
  const providers = res.locals.providers as ReelyProvider[];

  // Validate providerIndex as a non-negative integer string BEFORE coercion
  // (audit 12 #225). `+providerIndex` accepts `Infinity`/`NaN`/whitespace
  // strings, all of which would then index out-of-bounds into `providers`
  // and hit the !provider guard below -- but only by accident. Explicit
  // /^\d+$/ matches the same pattern used for metadataId / thumbId. A
  // failed regex short-circuits to `undefined`, which the same guard
  // catches alongside out-of-bounds indices (audit 15 #379 collapsed the
  // two near-identical guard bodies into one).
  const provider = /^\d+$/.test(providerIndex) ? providers[+providerIndex] : undefined;
  if (!provider) {
    logger.warn(`poster handler: invalid providerIndex ${providerIndex}`);
    res.status(404).send('Provider not found');
    return;
  }

  // Plex metadata and thumb ids are integers. Reject anything else so a request
  // like /api/poster/0/..%2Fsystem/thumb/1 can't traverse to a different Plex
  // API endpoint via URL pathname normalization.
  if (!/^\d+$/.test(metadataId) || !/^\d+$/.test(thumbId)) {
    logger.warn(
      `poster handler: rejected non-numeric ids metadataId=${metadataId} thumbId=${thumbId}`,
    );
    res.status(400).send('Invalid media id');
    return;
  }

  // Abort the upstream Plex fetch if the browser disconnects before the
  // stream finishes -- otherwise the proxy keeps pulling bytes into a dead
  // response. On normal completion this fires too, but aborting a settled
  // fetch is a harmless no-op.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  try {
    const [readableStream, headers] = await provider.getArtwork(
      `${metadataId}/${thumbId}`,
      abort.signal,
    );

    // Forward content-type and content-length from Plex if present.
    const contentType = headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    const contentLength = headers.get('content-length');
    if (contentLength) res.setHeader('content-length', contentLength);

    // Web API ReadableStream -> Node.js Readable -> Express response pipe.
    // as any: TypeScript's Node.js and DOM ReadableStream typedefs are
    // structurally compatible at runtime but their declared shapes disagree
    // at the boundary -- the cast is the documented contract here, also
    // noted on the ReelyProvider.getArtwork return type (audit 9 #114).
    // biome-ignore lint/suspicious/noExplicitAny: documented contract per comment above (ReadableStream vs Web ReadableStream shape mismatch at the Node/web boundary; audit 9 #114).
    const nodeStream = Readable.fromWeb(readableStream as any);
    // A mid-stream upstream error (including the abort above) must not surface
    // as an unhandled 'error' event. Log it and tear down the response.
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
