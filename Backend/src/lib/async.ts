import type { NextFunction, Request, RequestHandler, Response } from "express";

/// Express 4 does not forward a rejected promise to the error middleware, so
/// every async handler is wrapped rather than relying on it.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/// Retry with exponential backoff. Used for Arcus reads and RPC calls, never for
/// a signed mutation -- replaying one of those risks a duplicate order.
export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 250, label = "operation" } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(baseMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${attempts} attempts: ${String(lastError)}`);
}

/// A never-overlapping interval: the next tick is scheduled only once the
/// current one settles, so a slow reconciliation pass cannot stack up.
export function startWorker(
  name: string,
  intervalMs: number,
  tick: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };

  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
