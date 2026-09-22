export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, code = "INVALID_REQUEST", details?: unknown) =>
  new HttpError(400, message, code, details);

export const unauthorized = (message = "Authentication required", code = "UNAUTHORIZED") =>
  new HttpError(401, message, code);

export const forbidden = (message: string, code = "FORBIDDEN") => new HttpError(403, message, code);

export const notFound = (message: string, code = "NOT_FOUND") => new HttpError(404, message, code);

export const conflict = (message: string, code = "CONFLICT") => new HttpError(409, message, code);

export const serviceUnavailable = (message: string, code = "SERVICE_UNAVAILABLE") =>
  new HttpError(503, message, code);

/// A failure from the Arcus gateway, carrying enough of the response to decide
/// whether the ledger entry should be reversed or retried.
export class ArcusError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ArcusError";
  }
}
