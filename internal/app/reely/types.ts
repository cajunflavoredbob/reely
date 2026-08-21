import type { ReelyProvider } from './providers/types';

// Providers are injected via res.locals by app.ts middleware.
export interface RouteContext {
  providers: ReelyProvider[];
}
