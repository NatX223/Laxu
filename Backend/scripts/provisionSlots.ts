/**
 * `npm run slots:provision` -- set up the slot pool on Perpl. Idempotent: run it
 * again after funding a wallet or adding a key and it picks up where it stopped.
 *
 * One slot = one wallet = one Perpl account. For each n in 1..SLOT_COUNT (default 5):
 *
 *   SECRET_SLOT_<n>_EVM   the slot wallet's EVM key (required)
 *   PERPL_API_KEY_<n>     its Perpl API key token (optional)
 *   SECRET_SLOT_<n>_API   that key's secret, 64-hex seed or PEM (optional)
 *
 *   1. MON for gas >= SLOT_MIN_GAS_WEI (default 0.5 MON) -- printed, never auto-sent;
 *   2. no Perpl account yet: top the wallet up to the minimum account open amount
 *      from the float wallet, approve the exchange, createAccount(min);
 *   3. approve(exchange, MAX) if missing;
 *   4. allowOrderForwarding(true) unless the API already reports fw == true;
 *   5. API key: from env, else enrolled (PERPL_ORIGIN set; printed, never stored),
 *      else manual steps printed;
 *   6. upsert OperatorWallet + SubaccountSlot (accountIndex 0) -- a new slot
 *      whose account holds more than the reserve is not registered (see slots:register).
 *
 * Secrets are never written to disk or the database -- only their ref names.
 */

import type { Address } from "viem";

import { addressOfKey, floatAddress, floatWallet, publicClient, slotWalletClient } from "../src/chain/clients";
import { assetBalanceOf, transferAsset } from "../src/chain/writes";
import { db } from "../src/config/db";
import { config } from "../src/config/env";
import { createLogger, errorFields } from "../src/lib/logger";
import { enrollApiKey } from "../src/venue/perpl/enroll";
import { readSecrets, writeSecrets } from "../src/venue/perpl/enrollSlots";
import {
  allowOrderForwarding,
  createAccount,
  ensureExchangeApproval,
  getAccountByAddr,
  getMinAccountOpenCNS,
} from "../src/venue/perpl/exchange";
import { getWallet } from "../src/venue/perpl/rest";
import { cnsToAsset, collateralScale } from "../src/venue/perpl/units";

const log = createLogger("provision");

const SLOT_COUNT = Number(process.env.SLOT_COUNT || 5);
const MIN_GAS_WEI = BigInt(process.env.SLOT_MIN_GAS_WEI || "500000000000000000");
const APPROVED = 2n ** 128n;
/// Same threshold sweep.ts uses: below it, money above the reserve is left in place.
const DUST = 10_000n;
/// Where newly enrolled keys go (0600, gitignored); the same file scripts/perpl/enrollSlotKey.ts writes.
const SECRETS_FILE = "./secrets/slot-keys.json";

type Row = { n: number; address: string; account: string; key: string; status: string; ok: boolean };

function printSummary(rows: Row[]): void {
  console.log("");
  console.log("n   wallet                                      account   key        ok  status");
  console.log("--  ------------------------------------------  --------  ---------  --  ------");
  for (const r of rows) {
    console.log(
      `${String(r.n).padEnd(2)}  ${r.address.padEnd(42)}  ${r.account.padEnd(8)}  ${r.key.padEnd(9)}  ${r.ok ? "✓ " : "✗ "}  ${r.status}`,
    );
  }
  console.log("");
}

async function provisionOne(n: number): Promise<Row> {
  const evmRef = `SLOT_${n}_EVM`;
  const apiRef = `SLOT_${n}_API`;
  const evmKey = process.env[`SECRET_${evmRef}`];
  const row: Row = { n, address: "-", account: "-", key: "-", status: "", ok: false };
  if (!evmKey) {
    row.status = `SECRET_${evmRef} not set; skipped`;
    return row;
  }

  const address = addressOfKey(evmKey, `SECRET_${evmRef}`);
  row.address = address;
  const wallet = slotWalletClient(evmKey, evmRef);

  // 1. Gas.
  const gas = await publicClient().getBalance({ address });
  if (gas < MIN_GAS_WEI) {
    row.status = `needs MON: holds ${gas} wei, send at least ${MIN_GAS_WEI - gas} wei to ${address} and rerun`;
    return row;
  }

  // 2. Account.
  const scale = await collateralScale();
  const minCns = await getMinAccountOpenCNS();
  const minAsset = cnsToAsset(minCns, scale);
  let account = await getAccountByAddr(address as Address);
  if (account.accountId === 0n) {
    const held = await assetBalanceOf(address as Address);
    if (held < minAsset) {
      const shortfall = minAsset - held;
      const floatBalance = await assetBalanceOf(floatAddress());
      if (floatBalance < shortfall) {
        row.status = `float ${floatAddress()} holds ${floatBalance}, needs ${shortfall} to open the account`;
        return row;
      }
      const tx = await transferAsset(floatWallet(), address as Address, shortfall);
      log.info("slot wallet funded for account open", { n, shortfall: shortfall.toString(), tx });
    }
    await ensureExchangeApproval(wallet, APPROVED);
    const tx = await createAccount(wallet, minCns);
    log.info("Perpl account created", { n, tx });
    account = await getAccountByAddr(address as Address);
    if (account.accountId === 0n) {
      row.status = `createAccount landed (${tx}) but getAccountByAddr still reports none; rerun`;
      return row;
    }
  }
  row.account = account.accountId.toString();

  // 3. Approval for later deposits.
  await ensureExchangeApproval(wallet, APPROVED);

  // 5 (key first, so step 4 can read fw through it).
  let apiKey = process.env[`PERPL_API_KEY_${n}`];
  let apiSecret = process.env[`SECRET_${apiRef}`];
  let keyNote = "";
  if (!apiKey || !apiSecret) {
    if (config.perplOrigin) {
      const enrolled = await enrollApiKey({ evmPrivateKey: evmKey, label: `laxu-slot-${n}` });
      apiKey = enrolled.apiKey;
      apiSecret = enrolled.secretHex;
      // Never printed: the key and secret go only to the 0600, gitignored file
      // that scripts/perpl/enrollSlotKey.ts also writes.
      const file = readSecrets(SECRETS_FILE);
      file.env[`PERPL_API_KEY_${n}`] = enrolled.apiKey;
      file.env[`SECRET_${apiRef}`] = enrolled.secretHex;
      file.slots[String(n)] = {
        address,
        publicKey: enrolled.publicKeyHex,
        label: `laxu-slot-${n}`,
        scope: 3, // PERPL_SCOPE_READ_TRADE, what enrollApiKey requests
        origin: config.perplOrigin,
        enrolledAt: new Date().toISOString(),
      };
      writeSecrets(SECRETS_FILE, file);
      console.log(
        `\nSlot ${n}: new Perpl API key enrolled (key …${enrolled.apiKey.slice(-4)}). ` +
          `PERPL_API_KEY_${n} and SECRET_${apiRef} were written to ${SECRETS_FILE}; copy them into your env.\n`,
      );
      keyNote = "; key enrolled (see the secrets file)";
    } else {
      // Forwarding is idempotent: turn it on now so the key works as soon as it exists.
      await allowOrderForwarding(wallet, true);
      console.log(
        `\nSlot ${n}: no API key. Import ${address} into a browser wallet, open https://testnet.perpl.xyz/apikeys, ` +
          `create a key with trade scope, then set PERPL_API_KEY_${n} and SECRET_${apiRef} and rerun.\n`,
      );
      row.status = "account ready, forwarding on; needs an API key";
      return row;
    }
  }
  row.key = `…${apiKey.slice(-4)}`;

  // 4. Forwarding.
  let forwarding = false;
  try {
    const snapshot = await getWallet({ address, perplAccountId: row.account, apiKey, apiSecret });
    forwarding = (snapshot.as ?? []).some((a) => String(a.id) === row.account && a.fw);
  } catch (error) {
    log.warn("signed wallet read failed; enabling forwarding anyway", { n, ...errorFields(error) });
  }
  if (!forwarding) {
    await allowOrderForwarding(wallet, true);
    forwarding = true;
  }

  // 6. Database.
  const reserve = config.perplSlotReserve ? BigInt(config.perplSlotReserve) : minAsset;
  // settlement.ts pays everything above the reserve to the first position's
  // holders, so a new slot that already holds more is left to slots:register,
  // which can sweep the excess to the float first.
  const existing = await db.subaccountSlot.findFirst({
    where: { operatorWallet: { address: address.toLowerCase() }, accountIndex: 0 },
  });
  if (!existing) {
    const free = account.balanceCNS > account.lockedBalanceCNS ? account.balanceCNS - account.lockedBalanceCNS : 0n;
    const excess = cnsToAsset(free, scale) - reserve;
    if (excess > DUST) {
      row.status =
        `not registered: account holds ${excess} units above the ${reserve} reserve; ` +
        `run npm run slots:register -- --slots ${n} --sweep-excess --apply`;
      return row;
    }
  }
  const operatorWallet = await db.operatorWallet.upsert({
    where: { address: address.toLowerCase() },
    create: { address: address.toLowerCase(), evmSignerRef: evmRef },
    update: { evmSignerRef: evmRef },
  });
  await db.subaccountSlot.upsert({
    where: { operatorWalletId_accountIndex: { operatorWalletId: operatorWallet.id, accountIndex: 0 } },
    create: {
      operatorWalletId: operatorWallet.id,
      accountIndex: 0,
      apiKey,
      apiSecretRef: apiRef,
      perplAccountId: row.account,
      forwardingEnabled: forwarding,
      reserve: reserve.toString(),
    },
    update: {
      apiKey,
      apiSecretRef: apiRef,
      perplAccountId: row.account,
      forwardingEnabled: forwarding,
      reserve: reserve.toString(),
    },
  });
  row.ok = true;
  row.status = `ready${keyNote}`;
  return row;
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (let n = 1; n <= SLOT_COUNT; n += 1) {
    try {
      rows.push(await provisionOne(n));
    } catch (error) {
      log.error("slot provisioning failed", { n, ...errorFields(error) });
      rows.push({ n, address: "-", account: "-", key: "-", ok: false, status: `error: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  printSummary(rows);
  await db.$disconnect();
}

main().catch(async (error) => {
  log.error("provisioning aborted", errorFields(error));
  await db.$disconnect();
  process.exit(1);
});
