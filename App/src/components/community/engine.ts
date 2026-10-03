"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getGlobalStats, getListedPositions, type GlobalStats } from "@/lib/api";
import { fromCard, type KindKey, type SortKey, type Token } from "./data";
import { derive, type ViewState } from "./derive";

export type CommunityProps = {
  /** rows below the spotlight, per page */
  rowsPerPage?: number;
  /** how many top performers get a card */
  spotlightCount?: number;
  /** re-read the listed positions every `REFRESH_MS` */
  liveTicker?: boolean;
};

/** How often the list refreshes; position stats move on the reporter's cadence, not per tick. */
const REFRESH_MS = 30_000;

export type LoadState = "loading" | "ready" | "error";

const INITIAL: ViewState = { sort: "vol", kind: "all", query: "", page: 1 };

export function useCommunityEngine({
  rowsPerPage = 8,
  spotlightCount = 3,
  liveTicker = true,
}: CommunityProps) {
  const router = useRouter();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [st, setSt] = useState<ViewState>(INITIAL);

  // Listed and open: a closed token can't be bought into, so it has no place
  // in the market. A failed refresh keeps the last good list on screen.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getListedPositions({ status: "open" })
        .then(({ positions }) => {
          if (cancelled) return;
          setTokens(positions.map(fromCard));
          setLoad("ready");
        })
        .catch((error) => {
          console.error("GET /positions failed", error);
          if (!cancelled) setLoad((l) => (l === "ready" ? l : "error"));
        });
      getGlobalStats()
        .then((s) => !cancelled && setStats(s))
        .catch(() => {
          // the hero falls back to totals over the loaded rows
        });
    };
    refresh();
    const timer = liveTicker ? setInterval(refresh, REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [liveTicker]);

  // buying in happens on the position page, against the real token
  const buy = useCallback((t: Token) => router.push("/position/" + t.address), [router]);

  const vals = useMemo(
    () => derive(tokens, stats, st, { rowsPerPage, spotlightCount }),
    [tokens, stats, st, rowsPerPage, spotlightCount],
  );

  const setSort = useCallback((sort: SortKey) => setSt((s) => ({ ...s, sort, page: 1 })), []);
  const setKind = useCallback((kind: KindKey) => setSt((s) => ({ ...s, kind, page: 1 })), []);
  const setQuery = useCallback((query: string) => setSt((s) => ({ ...s, query, page: 1 })), []);
  const goto = useCallback((page: number) => setSt((s) => ({ ...s, page })), []);
  const prev = useCallback(() => setSt((s) => ({ ...s, page: Math.max(1, vals.page - 1) })), [vals.page]);
  const next = useCallback(
    () => setSt((s) => ({ ...s, page: Math.min(vals.pageCount, vals.page + 1) })),
    [vals.page, vals.pageCount],
  );

  return { st, load, vals, buy, setSort, setKind, setQuery, goto, prev, next };
}

export type CommunityEngine = ReturnType<typeof useCommunityEngine>;
