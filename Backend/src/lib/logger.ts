import { config } from "../config/env";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(config.logLevel as Level) in ORDER ? (config.logLevel as Level) : "info"];

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, scope, message, ...fields };
  const serialised = JSON.stringify(line, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (level === "error") console.error(serialised);
  else if (level === "warn") console.warn(serialised);
  else console.log(serialised);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    child: (suffix) => createLogger(`${scope}:${suffix}`),
  };
}

export const logger = createLogger("laxu");

/// Operational drift and stuck-state findings from the reconciler. Routed through
/// one function so wiring PagerDuty/Slack later is a single edit.
export function alert(message: string, fields?: Record<string, unknown>): void {
  emit("error", "alert", message, fields);
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
