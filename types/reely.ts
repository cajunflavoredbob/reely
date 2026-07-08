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
  // Extra WebSocket Origin values to accept beyond same-origin. Needed when a
  // reverse proxy serves reely under an external origin that differs from the
  // internal Host header. Env: ALLOWED_ORIGINS (comma-separated).
  allowedOrigins?: string[];
  // When false, the server's Plex `baseUrl` is withheld from the WS `config`
  // frame. The browser then falls back to building "Open in Plex" links
  // through app.plex.tv instead of probing the local Plex directly.
  // Defaults to true (preserves 0.3.20 behavior). Set false on deployments
  // where leaking the internal Plex address to anyone with WS access is
  // unwanted -- e.g. WAN-exposed reely without basicAuth. (audit 10 #165 /
  // audit 12 #226.) Env: EXPOSE_PLEX_BASE_URL.
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

// Provider types implemented in this codebase. Extend the union whenever a
// new ReelyProvider is added (e.g. 'emby', 'jellyfin'). Frontend code that
// renders provider-specific UI should narrow on this type.
export type ProviderType = "plex";

export interface AppConfig {
  requiresConfiguration: boolean;
  serverName?: string;
  providerType?: ProviderType;
  // The Plex server's machine identifier. The frontend needs it to build
  // "Open in Plex" links (both the app.plex.tv web URL and the plex://
  // deep link). Not sensitive -- it appears in every such link anyway.
  plexServerId?: string;
  // The Plex server's base URL (no token), exactly as the server has it
  // configured. The frontend probes it at runtime to decide whether to
  // build a direct "Open in Plex" link to the local server (LAN) or to
  // fall back to app.plex.tv (WAN / mixed-content / Plex unreachable).
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
  // SCAFFOLDING: kept deliberately for the 1.0 Emby/Jellyfin provider
  // work. Plex auth is anonymous (no per-user avatars in the swipe
  // session); Emby and Jellyfin both surface a per-user avatar via
  // their auth APIs. When those providers land, the field gets wired
  // through `Avatar.tsx`'s `avatarUrl` branch (also marked SCAFFOLDING).
  // the owner's call in 0.4.4. Auditors: this is intentionally unused
  // today; please do not flag.
  avatarImage?: string;
}

// Create Room

export interface Filter {
  key: string;
  operator: string;
  value: string[];
}

export interface CreateRoomRequest {
  // Canonical (lowercased, allowlist-stripped) room name. Used as Map key,
  // filename, and URL parameter value.
  roomName: string;
  // Display form -- preserves case for UI rendering. The server keeps this
  // alongside the canonical name. Optional for pre-0.2.19 protocol clients;
  // when absent, the canonical name is used for display too.
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
    // RoomLimitError can reach the join path via joinOrCreateRoom's
    // disk-load branch (addRoom past MAX_ROOMS). Surfacing it as its
    // own variant lets the UI show "room limit reached" instead of the
    // generic "unexpected error" copy (audit 11 #177).
    | "RoomLimitError"
    // The requested userName is in use by another live connection in
    // this room (audit 16 / 0.5.22). The UI shows the message verbatim
    // so the user can pick a different name.
    | "UsernameTakenError"
    | "NotLoggedInError"
    | "UnknownError";
  message: string;
}

export interface JoinRoomSuccess {
  // The server-sanitized canonical room name. Clients should adopt this as
  // the authoritative name rather than relying on the user-typed input,
  // which may have leading/trailing whitespace or characters the server
  // strips. Optional for backward-compat with the pre-0.2.10 protocol.
  roomName?: string;
  // Display form of the room name (case preserved). Optional for backward-
  // compat with the pre-0.2.19 protocol; clients should fall back to
  // roomName when absent.
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
  // reely is movie-only by design (0.4.1). The field is kept on the wire so
  // a future provider could narrow the literal -- today it is always "movie".
  type: "movie";
  title: string;
  description: string;
  tagline?: string;
  year?: number;
  posterUrl?: string;
  // Raw Plex metadata key (e.g. "/library/metadata/12345"). The frontend
  // builds the "Open in Plex" web + app links from this plus the server id
  // in AppConfig.
  plexKey: string;
  genres: string[];
  // duration + rating are optional because a Plex item can legitimately
  // ship without them (rare but it happens -- newly-imported, no agent
  // match yet). Prior to 0.4.3 the provider coerced an undefined Plex
  // field with Number(undefined) -> NaN and shipped NaN on the wire; UI
  // consumers truthy-gate, so NaN's falsiness hid it -- but the wire
  // type was lying. Optional matches the actual contract.
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
  // Same rationale as Media.type -- movie-only by design (0.4.1).
  type: "movie";
}

export interface Filters {
  filters: Array<{
    title: string;
    key: string;
    type: string;
  }>;

  // e.g. { integer: [{ key: '=', title: 'is' }, { key: '!=', title: 'is not' }] }
  // Note, the meanings of certain keys (e.g. '=') can be different depending on the type
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
  // A percentage of the way through the room the user is
  progress: number;
}
