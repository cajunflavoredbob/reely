/// Plex Server Capabilities interface
/// Path: /
///
/// Narrowed to the two fields anything reads. Plex adds and drops response
/// fields freely, so declaring the rest just invites typecheck surprises.
export interface Capabilities {
  friendlyName: string;
  machineIdentifier: string;
}
