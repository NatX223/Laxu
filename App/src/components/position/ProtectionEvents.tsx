"use client";

import type { ProtectionEvent } from "@/lib/protection";
import { MONO } from "./shared";
import { ago, fmt, txLink } from "./ProtectionParts";

/**
 * The last 20 things protection did, one line each: a mark, what happened, the amount, health before to after
 * for a repay, how long ago, and a link to the transaction. The setup marker is bookkeeping and is not listed.
 */

const ICON: Record<string, { mark: string; color: string; word: string }> = {
  REPAID: { mark: "✓", color: "#5fe3a8", word: "Repaid" },
  PENDING: { mark: "…", color: "#ffd29c", word: "Repaying" },
  SKIPPED: { mark: "–", color: "#ffd29c", word: "Skipped" },
  FAILED: { mark: "✕", color: "#ff8a8a", word: "Failed" },
  ENABLED: { mark: "●", color: "#5fe3a8", word: "Enabled" },
  DISABLED: { mark: "○", color: "#a79bd0", word: "Disabled" },
};

export default function ProtectionEvents({ events, decimals, symbol }: { events: ProtectionEvent[]; decimals: number; symbol: string }) {
  const shown = events.filter((e) => e.kind !== "CREATED").slice(0, 20);
  if (shown.length === 0) {
    return <div style={{ fontSize: 11.5, color: "#a79bd0" }}>Nothing yet. Protection acts only when your health reaches the trigger.</div>;
  }
  return (
    <ul aria-label="Protection activity" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {shown.map((e) => {
        const icon = ICON[e.kind] ?? ICON.SKIPPED;
        const href = e.txHash ? txLink(e.txHash) : null;
        const amount = e.amount && (e.kind === "REPAID" || e.kind === "PENDING") ? ` ${fmt(BigInt(e.amount), decimals)} ${symbol}` : "";
        const health = e.kind === "REPAID" && e.healthBefore && e.healthAfter ? `, health ${e.healthBefore.slice(0, 4)} → ${e.healthAfter.slice(0, 4)}` : "";
        const detail = e.kind === "SKIPPED" || e.kind === "FAILED" || e.kind === "DISABLED" ? e.note : null;
        return (
          <li key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11, lineHeight: 1.45, color: "#c2b6e4" }}>
            <span aria-hidden style={{ width: 12, flex: "none", textAlign: "center", color: icon.color }}>
              {icon.mark}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ color: "#fdfbf7" }}>{icon.word}</b>
              {amount}
              {health}
              {detail ? `: ${detail}` : ""}{" "}
              {href && (
                <a href={href} target="_blank" rel="noreferrer" style={{ color: "#ffd29c" }}>
                  tx ↗
                </a>
              )}
            </span>
            <span style={{ fontFamily: MONO, flex: "none", color: "#a79bd0" }}>{ago(e.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
