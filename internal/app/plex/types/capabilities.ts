/// Plex Server Capabilities interface
/// Path: /
///
/// Narrowed in 0.4.4 (audit 10 #142): only `friendlyName` and
/// `machineIdentifier` are actually read from this response anywhere in
/// the codebase. The prior ~50-field declaration was reference
/// documentation that Plex routinely violates (legacy fields disappear,
/// new ones appear); narrowing avoids a typecheck surprise if a future
/// Plex bump drops a field. The runtime response still has every field
/// Plex sends -- this just bounds what TS expects to read.
export interface Capabilities {
  friendlyName: string;
  machineIdentifier: string;
}
