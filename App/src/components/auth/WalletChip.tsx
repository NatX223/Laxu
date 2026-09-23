"use client";

import { useSession } from "@/lib/session";

const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The two chip styles the designs use: the frosted one in the community and
 * position nav, and the solid amber one on the trade bar.
 */
const TONES = {
  frost: {
    chip: {
      fontSize: 11.5,
      color: "#a79bd0",
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.12)",
      padding: "7px 12px",
    },
    login: { color: "#fdfbf7", background: "#9670ff", border: "1px solid #9670ff" },
    dot: "#5fe3a8",
    tag: "#fdfbf7",
  },
  amber: {
    chip: {
      fontSize: 12,
      fontWeight: 700,
      color: "#16130f",
      background: "#ffb765",
      border: "1px solid #ffb765",
      padding: "9px 15px",
    },
    login: {},
    dot: "#0b7a55",
    tag: "#16130f",
  },
} satisfies Record<string, { chip: React.CSSProperties; login: React.CSSProperties; dot: string; tag: string }>;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The connected-wallet chip: Privy's sign-in / sign-up when signed out, the
 * wallet (and @tag once the backend has answered) when signed in — click to
 * log out. Nothing wallet-dependent renders until Privy is ready.
 */
export default function WalletChip({ tone = "frost" }: { tone?: keyof typeof TONES }) {
  const { ready, authenticated, user, wallet, login, logout } = useSession();
  const t = TONES[tone];
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "inherit",
    borderRadius: 99,
    whiteSpace: "nowrap",
    ...t.chip,
  };

  if (!ready) {
    return (
      <div style={{ ...base, opacity: 0.55 }} aria-busy="true">
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: t.dot, opacity: 0.4 }} />
        <span style={{ fontFamily: MONO }}>&hellip;</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <button type="button" onClick={login} className="laxu-wallet" style={{ ...base, ...t.login, cursor: "pointer" }}>
        Log in / Sign up
      </button>
    );
  }

  const address = user?.walletAddress ?? wallet?.address;
  return (
    <button
      type="button"
      onClick={() => void logout()}
      title="Log out"
      className="laxu-wallet"
      style={{ ...base, cursor: "pointer" }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: t.dot }} />
      {user?.tag && <span style={{ color: t.tag }}>@{user.tag}</span>}
      <span style={{ fontFamily: MONO }}>{address ? short(address) : "setting up wallet…"}</span>
    </button>
  );
}
