/**
 * Spec 05 spike, step 0: everything that does NOT need the signer key.
 *
 *   npx ts-node --transpile-only scripts/privy/00-check.ts
 *
 * 1. Offline: the auth-key normaliser accepts the shapes the quickstart and the
 *    SDK use (SEC1 PEM, PKCS8 PEM, base64 PKCS8, `wallet-auth:` prefix).
 * 2. Reports which Privy env vars are set (names only, never values).
 * 3. If PRIVY_APP_ID / PRIVY_APP_SECRET are set: one read-only call (list one
 *    wallet) to prove the app credentials work. Creates nothing.
 */

import { generateKeyPairSync } from "node:crypto";

import { CAIP2, describeError, normalizeAuthKey, privy, run } from "./_lib";

run(async () => {
  // --- 1. key shapes ---------------------------------------------------------
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  const expected = pkcs8Der.toString("base64");
  const shapes: Record<string, string> = {
    "SEC1 PEM (openssl ecparam output)": privateKey.export({ format: "pem", type: "sec1" }).toString(),
    "PKCS8 PEM": privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    "PEM with literal \\n (single-line .env)": privateKey.export({ format: "pem", type: "pkcs8" }).toString().replace(/\n/g, "\\n"),
    "base64 PKCS8 DER": expected,
    "wallet-auth: prefix": `wallet-auth:${expected}`,
  };
  let ok = true;
  for (const [name, input] of Object.entries(shapes)) {
    const pass = normalizeAuthKey(input) === expected;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} key shape: ${name}`);
  }
  const { privateKey: wrong } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  let rejected = false;
  try {
    normalizeAuthKey(wrong.export({ format: "pem", type: "pkcs8" }).toString());
  } catch {
    rejected = true;
  }
  ok &&= rejected;
  console.log(`${rejected ? "ok  " : "FAIL"} key shape: a secp256k1 key is rejected`);

  // --- 2. env presence -------------------------------------------------------
  console.log(`\nchain: ${CAIP2}`);
  for (const name of ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_AUTH_PRIVATE_KEY", "PRIVY_SIGNER_ID", "PRIVY_TEST_CONTRACT", "ASSET_ADDRESS"]) {
    console.log(`${process.env[name]?.trim() ? "set    " : "MISSING"} ${name}`);
  }

  // --- 3. credentials, read only ---------------------------------------------
  if (process.env.PRIVY_APP_ID?.trim() && process.env.PRIVY_APP_SECRET?.trim()) {
    try {
      const page = await privy().wallets().list({ chain_type: "ethereum", limit: 1 });
      console.log(`\nok   app credentials accepted by Privy (wallets visible on first page: ${page.data.length})`);
    } catch (error) {
      ok = false;
      console.log(`\nFAIL app credentials: ${describeError(error)}`);
    }
  }

  if (!ok) throw new Error("one or more checks failed");
});
