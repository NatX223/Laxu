import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

import { generateEd25519KeyPair, loadEd25519PrivateKey, privateKeySeedHex } from "../../lib/ed25519";
import {
  describePayload,
  EnrollError,
  enrollmentHttp,
  publicKey0x,
  requestPayload,
  signEnrollment,
  submitEnroll,
} from "./enrollment";
import { getWallet } from "./rest";
import { signInFrame } from "./signing";
import type { PerplCredentials } from "./types";

/**
 * The body of scripts/perpl/enrollSlotKey.ts: enroll a fresh Perpl API key for
 * each slot wallet, write it to a 0600 secrets file, optionally verify it.
 * Everything it says goes through `print`, and nothing it prints is a secret:
 * only env variable NAMES, labels, public keys and success/failure.
 */

export interface EnrollSlotsOptions {
  slots: number[];
  scope: 1 | 2 | 3;
  /// `{n}` is replaced by the slot number.
  label: string;
  builderId?: number;
  maxBuilderFeePer100k?: number;
  dryRun: boolean;
  /// Verify each new key (signed read + one trading-socket sign-in).
  verify: boolean;
  /// Verify the keys already in `out`, enroll nothing.
  verifyOnly: boolean;
  out: string;
  origin: string;
  apiUrl: string;
  wsUrl: string;
  chainId: number;
}

export interface EnrollSlotsDeps {
  print: (line: string) => void;
  /// The slot wallet's EVM private key (SECRET_SLOT_<n>_EVM).
  evmKeyFor: (n: number) => string | undefined;
  /// Overridable for tests.
  verifyKey?: (credentials: PerplCredentials, wsUrl: string, chainId: number) => Promise<{ rest: boolean; ws: boolean }>;
}

export interface SecretsFile {
  generatedAt: string;
  /// Paste these into .env. PERPL_API_KEY_<n> is the X-API-Key token,
  /// SECRET_SLOT_<n>_API the Ed25519 seed (apiSecretRef SLOT_<n>_API).
  env: Record<string, string>;
  slots: Record<
    string,
    {
      address: string;
      publicKey: string;
      label: string;
      scope: number;
      origin: string;
      builderId?: number;
      maxBuilderFeePer100k?: number;
      enrolledAt: string;
      verified?: { rest: boolean; ws: boolean; at: string };
    }
  >;
}

export const apiKeyVar = (n: number) => `PERPL_API_KEY_${n}`;
export const apiSecretVar = (n: number) => `SECRET_SLOT_${n}_API`;

export function readSecrets(path: string): SecretsFile {
  if (!existsSync(path)) return { generatedAt: new Date().toISOString(), env: {}, slots: {} };
  return JSON.parse(readFileSync(path, "utf8")) as SecretsFile;
}

/// Owner read/write only. chmod is a no-op for group/other on Windows; the
/// directory is gitignored either way.
export function writeSecrets(path: string, file: SecretsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ ...file, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const MAX_FRESH_PAIRS = 3;

export async function runEnrollSlots(options: EnrollSlotsOptions, deps: EnrollSlotsDeps): Promise<{ ok: number; failed: number }> {
  const { print } = deps;
  const verify = deps.verifyKey ?? verifyKey;
  let ok = 0;
  let failed = 0;

  if (options.verifyOnly) {
    const file = readSecrets(options.out);
    for (const n of options.slots) {
      const slot = file.slots[String(n)];
      const apiKey = file.env[apiKeyVar(n)];
      const apiSecret = file.env[apiSecretVar(n)];
      if (!slot || !apiKey || !apiSecret) {
        print(`slot ${n}: no key in ${options.out}`);
        failed += 1;
        continue;
      }
      const result = await verify({ address: slot.address, perplAccountId: null, apiKey, apiSecret }, options.wsUrl, options.chainId);
      slot.verified = { ...result, at: new Date().toISOString() };
      print(`slot ${n}: signed read ${result.rest ? "OK" : "FAILED"}, trading-socket sign-in ${result.ws ? "OK" : "FAILED"}`);
      if (result.rest && result.ws) ok += 1;
      else failed += 1;
    }
    writeSecrets(options.out, file);
    return { ok, failed };
  }

  const http = enrollmentHttp({ apiUrl: options.apiUrl, origin: options.origin });

  for (const n of options.slots) {
    const evmKey = deps.evmKeyFor(n);
    if (!evmKey) {
      print(`slot ${n}: SECRET_SLOT_${n}_EVM is not set; skipped`);
      failed += 1;
      continue;
    }
    const wallet = privateKeyToAccount((evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`) as Hex);
    const label = options.label.replace("{n}", String(n));
    const builder =
      options.builderId !== undefined ? { builderId: options.builderId, maxBuilderFeePer100k: options.maxBuilderFeePer100k ?? 0 } : {};

    try {
      for (let attempt = 1; ; attempt += 1) {
        // Always a fresh pair: a revoked public key can never be enrolled again.
        const key = generateEd25519KeyPair();
        const publicKey = publicKey0x(key);
        const payload = await requestPayload(http, {
          chainId: options.chainId,
          address: wallet.address,
          publicKey,
          scope: options.scope,
          label,
          ...builder,
        });

        if (options.dryRun) {
          const summary = describePayload(payload.typedData);
          print(`slot ${n} (${wallet.address}): payload received; dry run, nothing signed or submitted`);
          print(`  statement: ${summary.statement ?? "(no statement field)"}`);
          print(`  fields: ${JSON.stringify(summary.fields)}`);
          print(`  domain: ${JSON.stringify(summary.domain)}`);
          ok += 1;
          break;
        }

        const { signature, popSignature } = await signEnrollment(payload.typedData, wallet, key);
        let info;
        try {
          info = await submitEnroll(http, { chainId: options.chainId, address: wallet.address, payload, signature, popSignature });
        } catch (error) {
          if (error instanceof EnrollError && error.kind === "key-exists" && attempt < MAX_FRESH_PAIRS) continue;
          throw error;
        }

        const file = readSecrets(options.out);
        file.env[apiKeyVar(n)] = info.api_key;
        file.env[apiSecretVar(n)] = `0x${privateKeySeedHex(key)}`;
        file.slots[String(n)] = {
          address: wallet.address,
          publicKey,
          label,
          scope: info.scope_mask ?? options.scope,
          origin: info.origin ?? options.origin,
          ...(info.builder_id !== undefined ? { builderId: info.builder_id } : {}),
          ...(info.max_builder_fee_per_100k !== undefined ? { maxBuilderFeePer100k: info.max_builder_fee_per_100k } : {}),
          enrolledAt: new Date().toISOString(),
        };
        writeSecrets(options.out, file);
        print(
          `slot ${n} (${wallet.address}): key enrolled, label "${label}", scope ${info.scope_mask}` +
            (info.builder_id !== undefined
              ? `, builder ${info.builder_id} (${info.builder_name ?? "?"}) ceiling ${info.max_builder_fee_pct ?? info.max_builder_fee_per_100k}`
              : "") +
            `. Saved to ${options.out} as ${apiKeyVar(n)} and ${apiSecretVar(n)}.`,
        );

        if (options.verify) {
          const result = await verify(
            { address: wallet.address, perplAccountId: null, apiKey: info.api_key, apiSecret: file.env[apiSecretVar(n)] },
            options.wsUrl,
            options.chainId,
          );
          file.slots[String(n)].verified = { ...result, at: new Date().toISOString() };
          writeSecrets(options.out, file);
          print(`slot ${n}: signed read ${result.rest ? "OK" : "FAILED"}, trading-socket sign-in ${result.ws ? "OK" : "FAILED"}`);
        }
        ok += 1;
        break;
      }
    } catch (error) {
      failed += 1;
      if (error instanceof EnrollError) {
        print(`slot ${n}: ${error.message}${error.detail ? ` Perpl said: ${JSON.stringify(error.detail)}` : ""}`);
      } else {
        print(`slot ${n}: failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  }

  if (!options.dryRun && ok > 0) {
    print(`\nNext: copy the values of these variables from ${options.out} into Backend/.env (do not paste them into chat):`);
    for (const n of options.slots) print(`  ${apiKeyVar(n)}  ${apiSecretVar(n)}`);
    print("then run `npm run slots:provision` (stores the new token on each slot row) and restart the ONE backend with workers.");
  }
  return { ok, failed };
}

/**
 * A signed REST read (GET /v1/trading/wallet) and one trading-socket sign-in
 * with the new key. One extra socket per wallet: Perpl caps a wallet's trading
 * sockets (4 per the spec), so never call this for many keys of one wallet at once.
 */
export async function verifyKey(credentials: PerplCredentials, wsUrl: string, chainId: number): Promise<{ rest: boolean; ws: boolean }> {
  const rest = await getWallet(credentials).then(
    () => true,
    () => false,
  );
  const ws = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`${wsUrl.replace(/\/$/, "")}/ws/v1/trading`, { autoPong: true });
    const done = (result: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 10_000);
    socket.on("open", () =>
      socket.send(JSON.stringify(signInFrame({ key: loadEd25519PrivateKey(credentials.apiSecret), apiKey: credentials.apiKey, chainId }))),
    );
    // mt 19 WalletSnapshot: the sign-in was accepted.
    socket.on("message", (data) => {
      try {
        if ((JSON.parse(String(data)) as { mt?: number }).mt === 19) done(true);
      } catch {
        // not JSON: ignore
      }
    });
    socket.on("close", () => done(false));
    socket.on("error", () => done(false));
  });
  return { rest, ws };
}
