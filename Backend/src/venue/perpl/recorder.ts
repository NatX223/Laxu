import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { config } from "../../config/env";

/**
 * Raw Perpl traffic recorder (PERPL_RECORD_DIR), for test fixtures and the
 * evidence in docs/perpl-findings.md. Off unless the env var is set.
 *
 *   <dir>/<slot>-<yyyy-mm-dd>.jsonl   trading-WS frames, both directions
 *   <dir>/rest-<yyyy-mm-dd>.jsonl     REST calls: {method, target, status, body}
 *
 * Everything is redacted before it touches disk: API key tokens, signatures,
 * nonces, secrets and X-API-* headers never land in a file. Recording must never
 * break trading, so every write error is swallowed.
 */

const REDACTED = "<redacted>";
const SECRET_KEYS = new Set(["api_key", "apikey", "key", "signature", "sig", "nonce", "secret", "api_secret", "private_key"]);

function isSecretKey(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_KEYS.has(lower) || lower.startsWith("x-api-");
}

/// A deep copy with every secret-looking field replaced.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
      out[name] = isSecretKey(name) ? REDACTED : redact(field);
    }
    return out;
  }
  return value;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function append(file: string, entry: Record<string, unknown>): void {
  const dir = config.perplRecordDir;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    appendFileSync(join(dir, file), `${line}\n`);
  } catch {
    // Never let a recording problem reach the trading path.
  }
}

export function recordingEnabled(): boolean {
  return Boolean(config.perplRecordDir);
}

/// One trading-WS frame. `raw` is the text as received when it did not parse.
export function recordFrame(slotId: string, dir: "in" | "out", frame: unknown): void {
  if (!config.perplRecordDir) return;
  append(`${slotId}-${today()}.jsonl`, { slot: slotId, dir, frame: redact(frame) });
}

/// One REST call. `wallet` is the slot wallet address (public) for signed calls.
export function recordRest(entry: {
  method: string;
  target: string;
  status: number | null;
  body: unknown;
  requestBody?: unknown;
  wallet?: string;
  error?: string;
}): void {
  if (!config.perplRecordDir) return;
  append(`rest-${today()}.jsonl`, redact(entry) as Record<string, unknown>);
}
