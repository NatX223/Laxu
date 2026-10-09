"use client";

import { useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { env } from "@/lib/env";
import { useSession } from "@/lib/session";

/**
 * Spec 05 spike 1.3: add or remove the server's Privy signer on the logged-in
 * user's embedded wallet. Dev tool only (see app/dev/privy/page.tsx); not
 * linked from anywhere and not styled to the product.
 *
 * Add signer needs the key quorum id (the server's PRIVY_SIGNER_ID) and the id
 * of a policy the backend/spike already created (02-policy.ts prints it). The
 * browser never sees the private key.
 */
export default function DevPrivy() {
  // Without an app id there is no PrivyProvider, and useSigners would throw.
  if (!env.privyAppId) return <Shell>NEXT_PUBLIC_PRIVY_APP_ID is not set, so Privy is not mounted.</Shell>;
  return <Panel />;
}

function Panel() {
  const { ready, authenticated, user, wallet, login } = useSession();
  const { addSigners, removeSigners } = useSigners();
  const [signerId, setSignerId] = useState(env.privySignerId);
  const [policyId, setPolicyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  const address = user?.walletAddress ?? "";
  // Signers attach to Privy wallets, not MetaMask & co. (Spec 05 2.0b).
  const embedded = wallet?.walletClientType === "privy";

  const note = (line: string) => setLog((prev) => `${new Date().toISOString().slice(11, 19)}  ${line}\n${prev}`);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    note(`${label} ...`);
    try {
      await fn();
      note(`${label}: OK`);
    } catch (error) {
      // Privy's own message only; never anything that could carry a secret.
      note(`${label}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    act("addSigners", async () => {
      const id = signerId.trim();
      const policy = policyId.trim();
      if (!id) throw new Error("signer id (key quorum id) is required");
      await addSigners({ address, signers: [{ signerId: id, policyIds: policy ? [policy] : [] }] });
      note(`now run:  npx ts-node --transpile-only scripts/privy/03-user-signer.ts --wallet ${address}`);
    });

  const remove = () =>
    act("removeSigners", async () => {
      await removeSigners({ address });
      note(`then run:  npx ts-node --transpile-only scripts/privy/03-user-signer.ts --wallet ${address} --expect-removed`);
    });

  if (!ready) return <Shell>Loading Privy ...</Shell>;
  if (!authenticated) {
    return (
      <Shell>
        <p>Sign in with email so the wallet is a Privy embedded wallet.</p>
        <button style={btn} onClick={login}>
          Sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <p>
        Laxu wallet: <code>{address || "(loading)"}</code>
        <br />
        Kind: <b>{wallet ? (embedded ? "Privy embedded wallet" : `external (${wallet.walletClientType}); signers will not work`) : "not connected yet"}</b>
      </p>

      <label style={lbl}>
        Signer id (server key quorum id)
        <input style={inp} value={signerId} onChange={(e) => setSignerId(e.target.value)} placeholder="PRIVY_SIGNER_ID" spellCheck={false} />
      </label>
      <label style={lbl}>
        Policy id (from 02-policy.ts; allow-only, no DENY-all)
        <input style={inp} value={policyId} onChange={(e) => setPolicyId(e.target.value)} placeholder="policy id" spellCheck={false} />
      </label>

      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Add signer lets the Laxu server act on this wallet within the policy above (and nothing else). Remove signer revokes it.
      </p>

      <div style={{ display: "flex", gap: 12, margin: "12px 0" }}>
        <button style={btn} disabled={busy || !embedded || !address} onClick={add}>
          Add signer
        </button>
        <button style={btn} disabled={busy || !embedded || !address} onClick={remove}>
          Remove signer
        </button>
      </div>

      <textarea style={{ ...inp, height: 260, fontFamily: "monospace", fontSize: 12 }} readOnly value={log} placeholder="results appear here" />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px", color: "#fdfbf7", background: "#1c1638", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20 }}>Privy signer spike (dev only)</h1>
      {children}
    </main>
  );
}

const btn: React.CSSProperties = { padding: "8px 16px", borderRadius: 6, border: "1px solid #fdfbf7", background: "transparent", color: "inherit", cursor: "pointer" };
const lbl: React.CSSProperties = { display: "block", margin: "12px 0", fontSize: 13 };
const inp: React.CSSProperties = { display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 6, border: "1px solid #6b5fa5", background: "#120d2a", color: "inherit", boxSizing: "border-box" };
