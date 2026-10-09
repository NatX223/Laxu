/**
 * Spec 05 spike, step 00: create the Privy server signer (a 1-of-1 key quorum).
 *
 *   npx ts-node --transpile-only scripts/privy/00-create-signer.ts
 *
 * One-off. Generates a P-256 key pair, registers the public half as a key quorum
 * (threshold 1, display name "laxu-server"), and writes PRIVY_SIGNER_ID and
 * PRIVY_AUTH_PRIVATE_KEY to Backend/.env. A backup of both goes to
 * ~/privy-signer-backup.txt (outside the repo, owner-only).
 *
 * The private key is never printed or logged; the script prints the quorum id,
 * whether .env was updated, the backup path and the first 6 characters of the app id.
 * It refuses to run if either variable already exists (never overwrites).
 */

import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { generateP256KeyPair, PrivyClient } from "@privy-io/node";

const ENV_PATH = resolve(__dirname, "../../.env");
const BACKUP_PATH = resolve(homedir(), "privy-signer-backup.txt");
const DISPLAY_NAME = "laxu-server";

/** Owner-only: mode 600 on POSIX, and on Windows (which ignores the mode) strip inherited ACLs and grant the current user only. */
function lockDown(path: string): void {
  if (process.platform === "win32") {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore" });
  }
}

async function main(): Promise<void> {
  // --- preflight: never overwrite -------------------------------------------
  if (!existsSync(ENV_PATH)) throw new Error("Backend/.env not found");
  const envText = readFileSync(ENV_PATH, "utf8");
  const env = dotenv.parse(envText);
  for (const name of ["PRIVY_SIGNER_ID", "PRIVY_AUTH_PRIVATE_KEY"]) {
    if (env[name]?.trim() || new RegExp(`^\\s*${name}\\s*=\\s*\\S`, "m").test(envText)) {
      throw new Error(`${name} already has a value in Backend/.env; refusing to overwrite`);
    }
  }
  if (existsSync(BACKUP_PATH)) throw new Error(`${BACKUP_PATH} already exists; refusing to overwrite`);
  const appId = env.PRIVY_APP_ID?.trim();
  const appSecret = env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET missing in Backend/.env");

  // --- 1. generate -------------------------------------------------------------
  const { publicKey, privateKey } = await generateP256KeyPair();

  // Local check: the private half really derives the public half (no network, nothing printed).
  const derived = createPublicKey(createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" })
    .toString("base64");
  if (derived !== publicKey) throw new Error("generated key pair is inconsistent");

  // --- 2. backup first, so the key can never be lost after registration -------
  writeFileSync(BACKUP_PATH, `PRIVY_AUTH_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600, flag: "wx" });
  lockDown(BACKUP_PATH);

  // --- 3. register -------------------------------------------------------------
  const client = new PrivyClient({ appId, appSecret });
  let quorumId: string;
  try {
    const quorum = await client.keyQuorums().create({
      public_keys: [publicKey],
      authorization_threshold: 1,
      display_name: DISPLAY_NAME,
    });
    quorumId = quorum.id;
  } catch (error) {
    unlinkSync(BACKUP_PATH); // nothing registered, so the key is worthless
    throw error;
  }
  writeFileSync(BACKUP_PATH, `PRIVY_SIGNER_ID=${quorumId}\nPRIVY_AUTH_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 });
  lockDown(BACKUP_PATH);

  // --- 4. .env (append only) ----------------------------------------------------
  const lead = envText.endsWith("\n") ? "" : "\n";
  appendFileSync(
    ENV_PATH,
    `${lead}\n# Privy server signer (Spec 05), created by scripts/privy/00-create-signer.ts\nPRIVY_SIGNER_ID=${quorumId}\nPRIVY_AUTH_PRIVATE_KEY=${privateKey}\n`,
  );
  const reread = dotenv.parse(readFileSync(ENV_PATH, "utf8"));
  const envOk = reread.PRIVY_SIGNER_ID === quorumId && reread.PRIVY_AUTH_PRIVATE_KEY === privateKey;

  // --- 5. verify (read only) -----------------------------------------------------
  const fetched = await client.keyQuorums().get(quorumId);
  const registered = fetched.authorization_keys.map((k) => k.public_key.replace(/\s+/g, ""));
  const verified =
    fetched.id === quorumId &&
    fetched.authorization_threshold === 1 &&
    fetched.display_name === DISPLAY_NAME &&
    registered.length === 1 &&
    registered[0] === publicKey;

  console.log(`quorum id:            ${quorumId}`);
  console.log(`.env updated:         ${envOk ? "yes (re-read and matches)" : "NO - re-read mismatch"}`);
  console.log(`backup file:          ${BACKUP_PATH}`);
  console.log(`app id (first 6):     ${appId.slice(0, 6)}`);
  console.log(`key quorum retrieved: ${verified ? "success (id, threshold 1, name, public key all match)" : "FAILED"}`);
  if (!envOk || !verified) process.exitCode = 1;
}

main().catch((error) => {
  // Message only: SDK errors can carry request context, so never dump the object.
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
