export class ReelyError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Extends ReelyError (was: extends Error) so it inherits the
// this.constructor.name pattern -- audit 15 #382 aligned the two
// error classes. The 21 ReelyError subclasses in config/errors.ts
// rely on that constructor for their per-class err.name surfacing;
// extending it here gives ReelyUnknownError the same behavior with
// no instanceof breakage (verified: no callers use
// `instanceof ReelyError` / `instanceof ReelyUnknownError`).
export class ReelyUnknownError extends ReelyError {}

export function assert(
  expr: unknown,
  msg = "",
  ErrorType = ReelyUnknownError,
): asserts expr {
  if (!expr) {
    throw new ErrorType(msg);
  }
}

export function isRecord(
  value: unknown,
  name = "value",
  ErrorType = ReelyError,
): asserts value is Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null,
    `${name} must be an object`,
    ErrorType,
  );
}
