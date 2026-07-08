import type { ReelyProvider } from './providers/types';

// Simplified context -- providers are injected via res.locals by app.ts middleware.
export interface RouteContext {
  providers: ReelyProvider[];
}
