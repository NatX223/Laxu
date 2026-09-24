"use client";

import { useEffect, useState } from "react";
import { getTriggerExits, type TriggerExit } from "@/lib/api";
import { useSession } from "@/lib/session";

/** How often the backend is asked for new SL/TP exits. Triggers run on a one-minute tick. */
const POLL_MS = 60_000;
const SEEN_KEY = "laxu.seenTriggerExits";
const SHOW_MS = 9_000;

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function markSeen(id: string): void {
  try {
    const seen = readSeen();
    seen.add(id);
    // Exits older than a week drop out of the feed, so the list stays short.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-100)));
  } catch {
    // Private mode: the toast may repeat on the next visit, nothing worse.
  }
}

/** "Your stop loss on ETH Long 5x #042 executed: $142.10 sent to your wallet." */
function messageFor(exit: TriggerExit): string {
  const name = exit.position.name.replace(/^Laxu /, "");
  const what = exit.kind === "take_profit" ? "take profit" : "stop loss";
  return `Your ${what} on ${name} executed: $${Number(exit.assets).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} sent to your wallet.`;
}

/**
 * Tells the signed-in user when one of their SL/TP levels fired, wherever they
 * are in the app: polls their recent trigger exits and shows each unseen one
 * once. Seen ids live in localStorage, so a later visit still hears about an
 * exit that happened while they were away.
 */
export default function TriggerNotifier() {
  const { wallet } = useSession();
  const address = wallet?.address;
  const [queue, setQueue] = useState<TriggerExit[]>([]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const check = () =>
      getTriggerExits(address)
        .then(({ triggerExits }) => {
          if (cancelled) return;
          const seen = readSeen();
          const fresh = triggerExits.filter((exit) => !seen.has(exit.id));
          if (fresh.length === 0) return;
          setQueue((current) => {
            const queued = new Set(current.map((exit) => exit.id));
            // Oldest first, so they read in the order they happened.
            return current.concat(fresh.filter((exit) => !queued.has(exit.id)).reverse());
          });
        })
        .catch((error) => console.error("could not check SL/TP exits", error));
    void check();
    const id = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address]);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    markSeen(current.id);
    const id = setTimeout(() => setQueue((q) => q.slice(1)), SHOW_MS);
    return () => clearTimeout(id);
  }, [current]);

  if (!current) return null;

  return (
    <div
      role="status"
      onClick={() => setQueue((q) => q.slice(1))}
      style={{
        position: "fixed",
        zIndex: 60,
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "min(560px, calc(100vw - 32px))",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 18px",
        borderRadius: 14,
        cursor: "pointer",
        background: "rgba(36,28,70,0.94)",
        border: "1px solid rgba(255,255,255,0.18)",
        backdropFilter: "blur(18px)",
        boxShadow: "0 18px 40px rgba(10,6,28,0.5)",
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: current.kind === "take_profit" ? "#5fe3a8" : "#ffb765",
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.45, color: "#fdfbf7" }}>{messageFor(current)}</span>
    </div>
  );
}
