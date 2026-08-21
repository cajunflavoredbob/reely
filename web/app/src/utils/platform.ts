// Module-level constant, not a function, so the userAgent test runs once.

// iOS Safari needs target="_self" on external links; target="_blank" opens a
// tab that never loads. iPadOS 13+ reports as "MacIntel" and misses this
// check, which only costs it the _self workaround.
export const isIOS = /(iPhone|iPad)/.test(navigator.userAgent);
