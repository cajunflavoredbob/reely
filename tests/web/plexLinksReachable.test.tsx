// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// The probe result is cached at module scope, so every case re-imports the
// module to start from a cold cache.
const freshModule = async () => {
  vi.resetModules();
  return await import('../../web/app/src/utils/plexLinks');
};

const BASE = 'http://192.168.1.15:32400';
const OTHER_BASE = 'http://192.168.1.16:32400';

// The probe uses mode: 'no-cors' and never reads the response, so resolving
// with nothing is enough to stand in for a reachable server.
const reachable = () => vi.fn().mockResolvedValue(undefined);
const unreachable = () => vi.fn().mockRejectedValue(new Error('network error'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeLocalPlexReachable', () => {
  it('resolves false without fetching when no base URL is known', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const { probeLocalPlexReachable } = await freshModule();
    await expect(probeLocalPlexReachable(undefined)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes /identity once and shares that result with later callers', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const { probeLocalPlexReachable } = await freshModule();
    await expect(probeLocalPlexReachable(BASE)).resolves.toBe(true);
    await expect(probeLocalPlexReachable(BASE)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/identity`);
  });

  it('resolves false when the probe rejects', async () => {
    vi.stubGlobal('fetch', unreachable());
    const { probeLocalPlexReachable } = await freshModule();
    await expect(probeLocalPlexReachable(BASE)).resolves.toBe(false);
  });

  it('re-probes when the base URL changes', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const { probeLocalPlexReachable } = await freshModule();
    await probeLocalPlexReachable(BASE);
    await probeLocalPlexReachable(OTHER_BASE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Without the TTL, a phone that walked off the house Wi-Fi kept linking at
  // the LAN address for the life of the tab.
  it('re-probes once the cached result is older than the TTL', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const { probeLocalPlexReachable } = await freshModule();

    await probeLocalPlexReachable(BASE);
    clock.mockReturnValue(start + 59_000);
    await probeLocalPlexReachable(BASE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(start + 61_000);
    await probeLocalPlexReachable(BASE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useLocalPlexReachable', () => {
  it('reports undefined while probing, then the result', async () => {
    vi.stubGlobal('fetch', reachable());
    const { useLocalPlexReachable } = await freshModule();
    const { result } = renderHook(() => useLocalPlexReachable(BASE));
    expect(result.current).toBeUndefined();
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('re-probes on an online event, so a network change flips the answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);
    const { useLocalPlexReachable } = await freshModule();
    const { result } = renderHook(() => useLocalPlexReachable(BASE));
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-probe on visibilitychange while the cached result is fresh', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const { useLocalPlexReachable } = await freshModule();
    const { result } = renderHook(() => useLocalPlexReachable(BASE));
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops its listeners on unmount', async () => {
    const fetchMock = reachable();
    vi.stubGlobal('fetch', fetchMock);
    const { useLocalPlexReachable } = await freshModule();
    const { result, unmount } = renderHook(() => useLocalPlexReachable(BASE));
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
