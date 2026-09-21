"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTokens, type KindKey, type SortKey, type Token } from "./data";
import { derive, type ViewState } from "./derive";

export type CommunityProps = {
  /** rows below the spotlight, per page */
  rowsPerPage?: number;
  /** how many top performers get a card */
  spotlightCount?: number;
  /** the 2.6s price drift */
  liveTicker?: boolean;
};

type State = ViewState & { toast: string };

const INITIAL: State = { sort: "vol", kind: "all", query: "", page: 1, toast: "" };

export function useCommunityEngine({
  rowsPerPage = 8,
  spotlightCount = 3,
  liveTicker = true,
}: CommunityProps) {
  // the draw is deterministic, so both sides of hydration start from the same list
  const [tokens, setTokens] = useState<Token[]>(buildTokens);
  const [st, setSt] = useState<State>(INITIAL);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // the prototype drifted prices in place on a `tick` counter; rebuilding the
  // rows immutably lands the same numbers and keeps the memo honest
  useEffect(() => {
    const timer = setInterval(() => {
      if (!liveTicker) return;
      setTokens((ts) =>
        ts.map((t, i) => {
          const d = (Math.sin(Date.now() / 1700 + i) + (Math.random() - 0.5)) * 0.0045;
          const price = Math.max(0.05, t.price * (1 + d));
          return { ...t, price, chg: t.chg + d * 42, series: t.series.slice(1).concat([price]) };
        }),
      );
    }, 2600);
    return () => clearInterval(timer);
  }, [liveTicker]);

  useEffect(
    () => () => {
      if (toastT.current) clearTimeout(toastT.current);
    },
    [],
  );

  const buy = useCallback((t: Token) => {
    setSt((s) => ({
      ...s,
      toast: "Buy-in drafted — " + t.sym + " " + (t.long ? "long" : "short") + " " + t.lev + "×",
    }));
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setSt((s) => ({ ...s, toast: "" })), 2400);
  }, []);

  const vals = useMemo(
    () => derive(tokens, st, { rowsPerPage, spotlightCount }),
    [tokens, st, rowsPerPage, spotlightCount],
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

  return { st, vals, buy, setSort, setKind, setQuery, goto, prev, next };
}

export type CommunityEngine = ReturnType<typeof useCommunityEngine>;
