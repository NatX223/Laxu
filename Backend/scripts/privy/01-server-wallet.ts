/**
 * Spec 05 spike 1.1: can Privy act on Monad testnet (chain 10143)?
 *
 *   npx ts-node --transpile-only scripts/privy/01-server-wallet.ts [--fund]
 *
 * 1. Creates (or reuses) a Privy server wallet owned by the key quorum (PRIVY_SIGNER_ID).
 * 2. Needs ~0.02 MON on it. `--fund` sends 0.05 MON from the existing faucet wallet.
 * 3. Path A: wallets().ethereum().sendTransaction (Privy signs AND broadcasts), 1 wei to
 *    a dead address, five times; records hash, receipt, latency (median), and who set
 *    gas and nonce (we pass neither).
 * 4. Path B (only if A fails, or with --also-sign): signTransaction with gas/nonce/fees
 *    from our own RPC, then sendRawTransaction with viem.
 *
 * Needs: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SIGNER_ID, PRIVY_AUTH_PRIVATE_KEY.
 * Prints addresses, hashes and Privy's error bodies; never a key or secret.
 */

import { parseEther, type Address, type Hex } from "viem";

import { faucetWallet, publicClient } from "../../src/chain/clients";
import { sleep } from "../../src/lib/async";
import { CAIP2, CHAIN_ID, DEAD, authContext, describeError, loadState, median, privy, run, saveState, signerId, timed } from "./_lib";

const MIN_BALANCE = parseEther("0.02");
const ROUNDS = 5;

run(async () => {
  const args = new Set(process.argv.slice(2));
  const p = privy();

  // --- 1. wallet -------------------------------------------------------------
  let state = loadState();
  if (!state.serverWalletId) {
    const wallet = await p.wallets().create({
      chain_type: "ethereum",
      owner_id: signerId(),
      display_name: "laxu-spike-server-wallet",
    });
    state = saveState({ serverWalletId: wallet.id, serverWalletAddress: wallet.address });
    console.log(`created server wallet ${wallet.id} ${wallet.address}`);
  } else {
    console.log(`reusing server wallet ${state.serverWalletId} ${state.serverWalletAddress}`);
  }
  const walletId = state.serverWalletId!;
  const address = state.serverWalletAddress as Address;
  const rpc = publicClient();

  // --- 2. funding ------------------------------------------------------------
  let balance = await rpc.getBalance({ address });
  console.log(`balance ${balance} wei`);
  if (balance < MIN_BALANCE) {
    if (!args.has("--fund")) {
      console.log(`\nFund ${address} with >= 0.02 MON on Monad testnet, or re-run with --fund (sends 0.05 MON from the faucet wallet).`);
      process.exit(3);
    }
    const faucet = faucetWallet();
    const hash = await faucet.sendTransaction({ account: faucet.account!, chain: faucet.chain, to: address, value: parseEther("0.05") });
    console.log(`funding tx ${hash}`);
    await rpc.waitForTransactionReceipt({ hash });
    for (let i = 0; i < 20 && balance < MIN_BALANCE; i += 1) {
      await sleep(1000);
      balance = await rpc.getBalance({ address });
    }
    console.log(`balance now ${balance} wei`);
  }

  const authorization_context = authContext();
  const results: Record<string, unknown> = { chain: CAIP2, wallet: address };

  // --- 3. Path A: Privy signs and broadcasts ---------------------------------
  const latencies: number[] = [];
  const hashes: string[] = [];
  let pathAError: string | undefined;
  for (let i = 0; i < ROUNDS; i += 1) {
    try {
      const { value, ms } = await timed(() =>
        p.wallets().ethereum().sendTransaction(walletId, {
          caip2: CAIP2,
          params: { transaction: { to: DEAD, value: "0x1" } },
          authorization_context,
        }),
      );
      latencies.push(ms);
      hashes.push(value.hash);
      console.log(`A#${i + 1} ${ms} ms hash ${value.hash}`);
    } catch (error) {
      pathAError = describeError(error);
      console.log(`A#${i + 1} FAILED ${pathAError}`);
      break;
    }
  }
  if (hashes.length) {
    const receipt = await rpc.waitForTransactionReceipt({ hash: hashes[0] as Hex, timeout: 60_000 });
    const tx = await rpc.getTransaction({ hash: hashes[0] as Hex });
    results.pathA = {
      broadcast: true,
      okCount: hashes.length,
      medianMs: median(latencies),
      latenciesMs: latencies,
      firstHash: hashes[0],
      receiptStatus: receipt.status,
      chainIdOnTx: tx.chainId,
      gasLimitSetByPrivy: tx.gas.toString(),
      nonceSetByPrivy: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas?.toString(),
    };
  } else {
    results.pathA = { broadcast: false, error: pathAError };
  }

  // --- 4. Path B: Privy signs, viem broadcasts --------------------------------
  if (!hashes.length || args.has("--also-sign")) {
    try {
      const [nonce, fees, gas] = await Promise.all([
        rpc.getTransactionCount({ address, blockTag: "pending" }),
        rpc.estimateFeesPerGas(),
        rpc.estimateGas({ account: address, to: DEAD, value: 1n }),
      ]);
      const { value, ms } = await timed(() =>
        p.wallets().ethereum().signTransaction(walletId, {
          params: {
            transaction: {
              type: 2,
              chain_id: CHAIN_ID,
              to: DEAD,
              value: "0x1",
              nonce: `0x${nonce.toString(16)}`,
              gas_limit: `0x${(gas * 12n / 10n).toString(16)}`,
              max_fee_per_gas: `0x${fees.maxFeePerGas.toString(16)}`,
              max_priority_fee_per_gas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}`,
            },
          },
          authorization_context,
        }),
      );
      const hash = await rpc.sendRawTransaction({ serializedTransaction: value.signed_transaction as Hex });
      const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 60_000 });
      results.pathB = { signed: true, signMs: ms, hash, receiptStatus: receipt.status };
      console.log(`B signed in ${ms} ms, broadcast ${hash} -> ${receipt.status}`);
    } catch (error) {
      results.pathB = { signed: false, error: describeError(error) };
      console.log(`B FAILED ${describeError(error)}`);
    }
  }

  saveState({ spike11: results });
  console.log("\nRESULT 1.1\n" + JSON.stringify(results, null, 2));
  const a = results.pathA as { broadcast: boolean };
  const b = results.pathB as { signed?: boolean } | undefined;
  console.log(`\nGATE 1.1: ${a.broadcast ? "Privy broadcasts on 10143" : b?.signed ? "Privy signs only (viem broadcasts)" : "FAIL: neither works"}`);
});
