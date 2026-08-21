export class ReelyError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Extends ReelyError, not Error, to inherit the constructor that surfaces the
// subclass name as err.name.
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
