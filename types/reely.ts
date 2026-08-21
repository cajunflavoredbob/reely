/**
 * Shared API interfaces between the frontend and backend
 */

export interface BasicAuth {
  userName: string;
  password: string;
}

export interface Config {
  hostname: string;
  port: number;
  logLevel: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  rootPath: string;
  servers: Array<{
    type?: "plex";
    url: string;
    token: string;
    libraryTitleFilter?: string[];
  }>;
  basicAuth?: BasicAuth;
  tlsConfig?: {
    certFile: string;
    keyFile: string;
  };
  // Extra WebSocket Origins to accept beyond same-origin, for a proxy serving
  // reely under an origin that differs from the internal Host.
  // Env: ALLOWED_ORIGINS (comma-separated).
  allowedOrigins?: string[];
  // False withholds the Plex baseUrl from the WS config frame, so the browser
  // builds "Open in Plex" links via app.plex.tv instead of probing the local
  // Plex. Set it on deployments where the internal Plex address shouldn't
  // reach anyone with WS access (WAN-exposed, no basicAuth).
  // Env: EXPOSE_PLEX_BASE_URL.
  exposePlexBaseUrl?: boolean;
}

// Messages intended for the Server
export type ServerMessage =
  | { type: "login"; payload: Login }
  | { type: "logout" }
  | { type: "createRoom"; payload: CreateRoomRequest }
  | { type: "joinRoom"; payload: JoinRoomRequest }
  | { type: "joinOrCreateRoom"; payload: JoinRoomRequest }
  | { type: "leaveRoom" }
  | { type: "rate"; payload: Rate }
  | { type: "setLocale"; payload: Locale }
  | { type: "requestFilters" }
  | { type: "requestFilterValues"; payload: FilterValueRequest }
  | { type: "applyFilters"; payload: { filters: Filter[] } };

// Messages intended for the UI
export type ClientMessage =
  | { type: "loginError"; payload: LoginError }
  | { type: "loginSuccess"; payload: User }
  | { type: "logoutError"; payload: LogoutError }
  | { type: "logoutSuccess" }
  | { type: "createRoomError"; payload: CreateRoomError }
  | { type: "createRoomSuccess"; payload: JoinRoomSuccess }
  | { type: "joinRoomError"; payload: JoinRoomError }
  | { type: "joinRoomSuccess"; payload: JoinRoomSuccess }
  | { type: "leaveRoomSuccess" }
  | { type: "leaveRoomError"; payload: LeaveRoomError }
  | { type: "match"; payload: Match }
  | { type: "config"; payload: AppConfig }
  | { type: "translations"; payload: Translations }
  | { type: "requestFiltersSuccess"; payload: Filters }
  | { type: "requestFiltersError"; payload: { message: string } }
  | {
    type: "requestFilterValuesSuccess";
    payload: { request: FilterValueRequest; values: FilterValue[] };
  }
  | { type: "requestFilterValuesError"; payload: { key: string; message: string } }
  | { type: "userJoinedRoom"; payload: UserProgress }
  | { type: "userLeftRoom"; payload: User }
  | { type: "userProgress"; payload: UserProgress }
  | { type: "filterChangeApplied"; payload: { appliedBy: string; media: Media[]; filters: Filter[] } }
  | { type: "filterChangeError"; payload: { message: string } };

// Translations
export type TranslationKey =
  | "FILTERS_LOADING"
  | "RATE_SECTION_EXHAUSTED_CARDS"
  | "RATE_SECTION_EXHAUSTED_CARDS_FILTERED";

// Configure message

// Extend when a new ReelyProvider lands; provider-specific UI narrows on this.
export type ProviderType = "plex";

export interface AppConfig {
  requiresConfiguration: boolean;
  serverName?: string;
  providerType?: ProviderType;
  // Machine identifier, for building "Open in Plex" web and deep links. Not
  // sensitive: it appears in every such link anyway.
  plexServerId?: string;
  // Base URL as configured, no token. The frontend probes it to choose between
  // a direct local link and the app.plex.tv fallback.
  plexBaseUrl?: string;
}

// Translations message

export interface Locale {
  language: string;
}

export type Translations = Record<TranslationKey, string>;

// Login (when login is required to create a new room)

export type Login = { userName: string };

export interface LoginError {
  name: "MalformedMessage";
  message: string;
}

export interface LogoutError {
  name: "NotLoggedIn";
  message: string;
}

export interface User {
  userName: string;
  // SCAFFOLDING for Emby / Jellyfin, which expose per-user avatars. Plex auth
  // is anonymous, so this is intentionally unused today; the consumer is
  // Avatar.tsx's avatarUrl branch, also marked SCAFFOLDING.
  avatarImage?: string;
}

// Create Room

export interface Filter {
  key: string;
  operator: string;
  value: string[];
}

export interface CreateRoomRequest {
  // Canonical (lowercased, allowlist-stripped): Map key, filename, URL param.
  roomName: string;
  // Case-preserving form for the UI. Older clients omit it; fall back to
  // roomName.
  displayName?: string;
  filters?: Filter[];
}

export interface CreateRoomError {
  name:
    | "RoomExistsError"
    | "RoomLimitError"
    | "UnauthorizedError"
    | "NotLoggedInError"
    | "NoMediaError"
    | "InvalidRoomNameError"
    | "UnknownError";
  message: string;
}

// Join

export interface JoinRoomRequest {
  roomName: string;
}

export interface JoinRoomError {
  name:
    | "RoomNotFoundError"
    // Reaches the join path via joinOrCreateRoom's disk-load branch. Its own
    // variant so the UI can say "room limit reached", not "unexpected error".
    | "RoomLimitError"
    // userName is in use by another live connection in this room. The UI shows
    // the message verbatim so the user can pick another name.
    | "UsernameTakenError"
    | "NotLoggedInError"
    | "UnknownError";
  message: string;
}

export interface JoinRoomSuccess {
  // Server-sanitized canonical name. Clients must adopt this over the typed
  // input, which may carry whitespace or characters the server strips.
  // Optional for older protocol clients.
  roomName?: string;
  // Case-preserving form; fall back to roomName when absent.
  displayName?: string;
  previousMatches: Match[];
  media: Media[];
  users: Array<{ user: User; progress: number }>;
  filters?: Filter[];
}

// Leave

export interface LeaveRoomError {
  errorType: "NOT_JOINED"; // Can't leave a room you're not in
}

// In-Room

export interface Media {
  id: string;
  // Movie-only by design; kept on the wire for a future provider to widen.
  type: "movie";
  title: string;
  description: string;
  tagline?: string;
  year?: number;
  posterUrl?: string;
  // Raw Plex metadata key ("/library/metadata/12345"). Combined with the
  // AppConfig server id to build "Open in Plex" links.
  plexKey: string;
  genres: string[];
  // Optional because a Plex item can ship without them (newly imported, no
  // agent match yet).
  duration?: number;
  rating?: number;
  contentRating?: string;
}

export interface Match {
  matchedAt: number;
  media: Media;
  users: string[];
}

export interface Rate {
  rating: "like" | "dislike";
  mediaId: string;
}

// Filters

export interface Library {
  title: string;
  key: string;
  // Movie-only by design, same as Media.type.
  type: "movie";
}

export interface Filters {
  filters: Array<{
    title: string;
    key: string;
    type: string;
  }>;

  // e.g. { integer: [{ key: '=', title: 'is' }, { key: '!=', title: 'is not' }] }
  // A key like '=' can mean different things per type.
  filterTypes: Record<
    string,
    Array<{
      key: string;
      title: string;
    }>
  >;
}

export interface FilterValue {
  title: string;
  value: string;
}

export interface FilterValueRequest {
  key: string;
}

export interface UserProgress {
  user: User;
  // Percentage of the way through the room.
  progress: number;
}
