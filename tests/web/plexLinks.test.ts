import { describe, it, expect } from 'vitest';
import { buildPlexLinks } from '../../web/app/src/utils/plexLinks';
import type { Media } from '../../types/reely';

const media = (over: Partial<Media> = {}): Media => ({
  id: 'guid-1',
  type: 'movie',
  title: 'Test',
  description: '',
  plexKey: '/library/metadata/123',
  genres: [],
  duration: 0,
  rating: 0,
  ...over,
} as Media);

describe('buildPlexLinks', () => {
  it('returns undefined when the server id is missing', () => {
    expect(buildPlexLinks(media(), undefined)).toBeUndefined();
  });

  it('builds the app.plex.tv web URL with an encoded key', () => {
    const links = buildPlexLinks(media(), 'SRV123');
    expect(links?.webUrl).toBe(
      'https://app.plex.tv/desktop#!/server/SRV123/details?key=%2Flibrary%2Fmetadata%2F123',
    );
  });

  // The local path is taken when preferLocal is true AND a base URL exists.
  it('builds the local Plex web URL when preferLocal is true', () => {
    const links = buildPlexLinks(
      media(),
      'SRV123',
      'http://192.168.1.15:32400',
      true,
    );
    expect(links?.webUrl).toBe(
      'http://192.168.1.15:32400/web/index.html#!/server/SRV123/details?key=%2Flibrary%2Fmetadata%2F123',
    );
  });

  it('falls back to app.plex.tv when preferLocal is true but no base URL is known', () => {
    const links = buildPlexLinks(media(), 'SRV123', undefined, true);
    expect(links?.webUrl).toBe(
      'https://app.plex.tv/desktop#!/server/SRV123/details?key=%2Flibrary%2Fmetadata%2F123',
    );
  });

  it('falls back to app.plex.tv when preferLocal is false', () => {
    const links = buildPlexLinks(
      media(),
      'SRV123',
      'http://192.168.1.15:32400',
      false,
    );
    expect(links?.webUrl).toBe(
      'https://app.plex.tv/desktop#!/server/SRV123/details?key=%2Flibrary%2Fmetadata%2F123',
    );
  });

  it('strips a trailing slash from the base URL when building the local link', () => {
    const links = buildPlexLinks(
      media(),
      'SRV123',
      'http://192.168.1.15:32400/',
      true,
    );
    expect(links?.webUrl).toBe(
      'http://192.168.1.15:32400/web/index.html#!/server/SRV123/details?key=%2Flibrary%2Fmetadata%2F123',
    );
  });
});
