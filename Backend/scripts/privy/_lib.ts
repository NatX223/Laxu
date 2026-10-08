/**
 * Shared helpers for the Spec 05 Privy spike (scripts/privy/0*.ts). Spike code
 * only: nothing under src/ imports this.
 *
 * Secrets: PRIVY_APP_SECRET and PRIVY_AUTH_PRIVATE_KEY are read from the env and
 * never printed. State written to .e2e/ (gitignored) holds wallet ids and
 * addresses only.
 */

import "dotenv/config";
import { createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { APIError, PrivyClient } from "@privy-io/node";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import { config } from "../../src/config/env";

/** Thrown when a step needs a value the user has not provided yet. */
export class MissingEnv extends Error {
  constructor(
    readonly variable: string,
    why: string,
  ) {
    super(`${variable} is not set: ${why}`);
  }
}

export function need(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingEnv(name, why);
  return value;
}

export const CHAIN_ID = config.chainId; // 10143 on Monad testnet
export const CAIP2 = `eip155:${CHAIN_ID}`;

let client: PrivyClient | undefined;
export function privy(): PrivyClient {
  if (!client) {
    client = new PrivyClient({
      appId: need("PRIVY_APP_ID", "the Monad Privy app's id (Backend/.env)"),
      appSecret: need("PRIVY_APP_SECRET", "the Monad Privy app's secret (Backend/.env)"),
    });
  }
  return client;
}

/** The key quorum id registered in the dashboard; `signerId` for addSigners, `owner_id` for server wallets. */
export function signerId(): string {
  return need("PRIVY_SIGNER_ID", "the key quorum id from Dashboard -> Wallets -> Authorization keys -> Register key quorum");
}

/**
 * The SDK wants the authorization private key as base64 PKCS8 DER with no PEM
 * header (an optional `wallet-auth:` prefix is stripped by the SDK). The
 * quickstart's `openssl ecparam -genkey` writes a SEC1 PEM ("EC PRIVATE KEY"),
 * which is not that, so every common shape is accepted here and normalised.
 */
export function normalizeAuthKey(raw: string): string {
  const text = raw.trim().replace(/^wallet-auth:/, "").replace(/\\n/g, "\n");
  const key = text.includes("BEGIN")
    ? createPrivateKey(text)
    : (() => {
        const der = Buffer.from(text, "base64");
        try {
          return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        } catch {
          return createPrivateKey({ key: der, format: "der", type: "sec1" });
        }
      })();
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("PRIVY_AUTH_PRIVATE_KEY must be a P-256 (prime256v1) key");
  }
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

export function authContext() {
  const key = normalizeAuthKey(need("PRIVY_AUTH_PRIVATE_KEY", "the P-256 private key whose public half is registered in the key quorum"));
  return { authorization_private_keys: [key] };
}

// ---------------------------------------------------------------------------
// Test calls shared by 02 and 03
// ---------------------------------------------------------------------------

const erc20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** The ERC-20 the policy tests run against: PRIVY_TEST_CONTRACT, else AUSD (ASSET_ADDRESS). */
export function testToken(): Address {
  const value = process.env.PRIVY_TEST_CONTRACT?.trim() || process.env.ASSET_ADDRESS?.trim();
  if (!value) throw new MissingEnv("ASSET_ADDRESS", "no test ERC-20 (set PRIVY_TEST_CONTRACT or ASSET_ADDRESS)");
  return value as Address;
}

export const approveData = (spender: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, amount] });
export const transferData = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] });

/** Per-call cap used by the parameter-limit test (raw token units). */
export const PARAM_LIMIT = 1000n;

// ---------------------------------------------------------------------------
// State, timing, errors
// ---------------------------------------------------------------------------

const STATE = resolve(__dirname, "../../.e2e/privy-spike.json");

export interface SpikeState {
  serverWalletId?: string;
  serverWalletAddress?: string;
  policyId?: string;
  denyAllPolicyId?: string;
  [k: string]: unknown;
}

export function loadState(): SpikeState {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as SpikeState) : {};
}
export function saveState(patch: SpikeState): SpikeState {
  const next = { ...loadState(), ...patch };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2));
  return next;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Error text for the findings doc: HTTP status and the body Privy returned, nothing else. */
export function describeError(error: unknown): string {
  if (error instanceof APIError) return `HTTP ${error.status} ${JSON.stringify(error.error)}`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs a step that is expected to be rejected; returns the rejection text, or throws if it succeeded. */
export async function expectRejected(label: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    const out = await fn();
    console.log(`  [UNEXPECTED SUCCESS] ${label}: ${JSON.stringify(out)}`);
    return `UNEXPECTED SUCCESS ${JSON.stringify(out)}`;
  } catch (error) {
    const text = describeError(error);
    console.log(`  [rejected] ${label}\n      ${text}`);
    return text;
  }
}

/** Entry wrapper: a missing env var is a clean STOP (exit 2), not a stack trace. */
export function run(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (error) => {
      if (error instanceof MissingEnv) {
        console.error(`\nSTOP: ${error.message}`);
        process.exit(2);
      }
      console.error(`\nFAILED: ${describeError(error)}`);
      process.exit(1);
    },
  );
}
