/**
 * Register one operator wallet and its ten subaccount slots.
 *
 * Arcus caps subaccounts at 10 per wallet address (accountIndex 0-9), and an
 * Ed25519 API key binds to exactly one (wallet, index) pair at creation -- it
 * cannot be reused across indexes. So each slot needs its own key, and the pool
 * scales by running this again for another wallet, not by redesigning anything.
 *
 * Usage:
 *   ARCUS_OPERATOR_ADDRESS=0x... \
 *   OPERATOR_SIGNER_REF=operator_a_evm \
 *   npm run slots:provision
 *
 * Reads each slot's key pair from the environment:
 *   ARCUS_API_KEY_<i>          public Ed25519 key (64 hex) for accountIndex i
 *   SECRET_<REF>               private key, where REF is `<prefix>_SLOT_<i>`
 *
 * Slots whose key material is absent are skipped and reported, so partial
 * provisioning is a normal intermediate state rather than a failure. A slot
 * whose ARCUS_API_KEY_<i> does not match its secret is skipped too -- logged,
 * shown as ✗ in the summary, and not written to the database -- rather than
 * aborting every other slot's provisioning.
 */

import { privateKeyToAccount } from "viem/accounts";

import { loadEd25519PrivateKey, publicKeyHex } from "../src/arcus/ed25519";
import { db } from "../src/config/db";
import { hasSecret, resolveSecret } from "../src/config/secrets";
import { createLogger, errorFields } from "../src/lib/logger";

const log = createLogger("provision");

const ACCOUNT_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

type Row = { index: number; publicKey: string; status: string; ok: boolean | null };

function evmAddressOf(key: string): string {
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address.toLowerCase();
}

function printSummary(rows: Row[]): void {
  console.log("");
  console.log("index  public key  status                        ok");
  console.log("-----  ----------  ----------------------------  --");
  for (const row of rows) {
    const mark = row.ok === null ? "-" : row.ok ? "✓" : "✗";
    console.log(
      `${String(row.index).padEnd(5)}  ${(row.publicKey ? row.publicKey.slice(0, 8) : "-").padEnd(10)}  ${row.status.padEnd(28)}  ${mark}`,
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  const address = process.env.ARCUS_OPERATOR_ADDRESS?.toLowerCase();
  const evmSignerRef = process.env.OPERATOR_SIGNER_REF;
  const secretPrefix = process.env.OPERATOR_SECRET_PREFIX ?? evmSignerRef;

  if (!address || !evmSignerRef) {
    throw new Error("Set ARCUS_OPERATOR_ADDRESS and OPERATOR_SIGNER_REF");
  }
  if (!hasSecret(evmSignerRef)) {
    throw new Error(`No secret found for OPERATOR_SIGNER_REF=${evmSignerRef}`);
  }

  // The wallet's EVM key signs deposits, refunds and sweeps. If it does not
  // control ARCUS_OPERATOR_ADDRESS every slot below would be unusable, so this
  // one is fatal.
  let derivedAddress: string;
  try {
    derivedAddress = evmAddressOf(resolveSecret(evmSignerRef));
  } catch (error) {
    throw new Error(`${evmSignerRef} is not a valid EVM private key: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (derivedAddress !== address) {
    throw new Error(
      `The EVM key in ${evmSignerRef} controls ${derivedAddress}, not ARCUS_OPERATOR_ADDRESS=${address}`,
    );
  }

  const wallet = await db.operatorWallet.upsert({
    where: { address },
    create: { address, evmSignerRef, status: "active" },
    update: { evmSignerRef },
  });

  const rows: Row[] = [];

  for (const accountIndex of ACCOUNT_INDEXES) {
    const secretRef = `${secretPrefix}_slot_${accountIndex}`;
    const declaredKey = process.env[`ARCUS_API_KEY_${accountIndex}`];

    if (!hasSecret(secretRef)) {
      rows.push({ index: accountIndex, publicKey: "", status: "no key material (skipped)", ok: null });
      continue;
    }

    // Derive the public key from the secret rather than trusting the pair to be
    // typed in consistently -- a mismatch here is otherwise invisible until the
    // first order comes back 401.
    let derived: string;
    try {
      derived = publicKeyHex(loadEd25519PrivateKey(resolveSecret(secretRef)));
    } catch (error) {
      log.error("slot secret is not a valid Ed25519 key; skipping", { accountIndex, secretRef, ...errorFields(error) });
      rows.push({ index: accountIndex, publicKey: "", status: "invalid signing key", ok: false });
      continue;
    }
    if (declaredKey && declaredKey.toLowerCase() !== derived.toLowerCase()) {
      log.error("public key mismatch; skipping this slot", {
        accountIndex,
        declared: `ARCUS_API_KEY_${accountIndex}`,
        derivedFrom: secretRef,
      });
      rows.push({ index: accountIndex, publicKey: derived, status: "key mismatch (skipped)", ok: false });
      continue;
    }

    await db.subaccountSlot.upsert({
      where: {
        operatorWalletId_accountIndex: { operatorWalletId: wallet.id, accountIndex },
      },
      create: {
        operatorWalletId: wallet.id,
        accountIndex,
        arcusApiKey: derived,
        arcusApiSecretRef: secretRef,
        status: "free",
      },
      // Never reset status here: an allocated slot backs a live position.
      update: { arcusApiKey: derived, arcusApiSecretRef: secretRef },
    });

    rows.push({
      index: accountIndex,
      publicKey: derived,
      status: declaredKey ? "provisioned" : "provisioned (key unchecked)",
      ok: true,
    });
  }

  const provisioned = rows.filter((row) => row.ok === true).length;
  const failed = rows.filter((row) => row.ok === false).map((row) => row.index);
  log.info("operator wallet provisioned", { address, provisioned, failed });
  printSummary(rows);

  if (failed.length > 0) {
    log.warn("some slots were skipped because their key material is wrong; fix them and re-run", {
      accountIndexes: failed,
    });
    process.exitCode = 1;
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    log.error("provisioning failed", errorFields(error));
    await db.$disconnect();
    process.exit(1);
  });
