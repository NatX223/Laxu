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
 * provisioning is a normal intermediate state rather than a failure.
 */

import { loadEd25519PrivateKey, publicKeyHex } from "../src/arcus/ed25519";
import { db } from "../src/config/db";
import { hasSecret, resolveSecret } from "../src/config/secrets";
import { createLogger, errorFields } from "../src/lib/logger";

const log = createLogger("provision");

const ACCOUNT_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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

  const wallet = await db.operatorWallet.upsert({
    where: { address },
    create: { address, evmSignerRef, status: "active" },
    update: { evmSignerRef },
  });

  const skipped: number[] = [];
  let provisioned = 0;

  for (const accountIndex of ACCOUNT_INDEXES) {
    const secretRef = `${secretPrefix}_slot_${accountIndex}`;
    const declaredKey = process.env[`ARCUS_API_KEY_${accountIndex}`];

    if (!hasSecret(secretRef)) {
      skipped.push(accountIndex);
      continue;
    }

    // Derive the public key from the secret rather than trusting the pair to be
    // typed in consistently -- a mismatch here is otherwise invisible until the
    // first order comes back 401.
    const derived = publicKeyHex(loadEd25519PrivateKey(resolveSecret(secretRef)));
    if (declaredKey && declaredKey.toLowerCase() !== derived.toLowerCase()) {
      throw new Error(
        `ARCUS_API_KEY_${accountIndex} does not match the key derived from ${secretRef}`,
      );
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

    provisioned += 1;
  }

  log.info("operator wallet provisioned", { address, provisioned, skipped });

  if (skipped.length > 0) {
    log.warn(
      "slots with no key material were skipped; create their Arcus API keys and re-run",
      { accountIndexes: skipped },
    );
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    log.error("provisioning failed", errorFields(error));
    await db.$disconnect();
    process.exit(1);
  });
