"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSeries, PALETTE, type RangeKey, type Side, type Status } from "./data";
import { DEFAULT_REACTIONS, derive, type PositionConfig, type Reaction, type ViewState } from "./derive";

/** The prototype's props panel, one for one. */
export type PositionProps = {
  /** the creator's name for the position */
  nickname?: string;
  status?: Status;
  side?: Side;
  /** 2–20× */
  leverage?: number;
  /** creator's cut of every buy-in, in basis points */
  creatorFeeBps?: number;
  /** shows the loan chip when the position backs a borrow */
  collateralized?: boolean;
  /** A real buy-in for a minted token: resolves to the toast to show. Unset, the ticket is the prototype's. */
  onBuy?: (amountUsd: number) => Promise<string>;
};

type State = ViewState & { toast: string };

const INITIAL: State = {
  range: "30D",
  amount: "2,500",
  reacts: DEFAULT_REACTIONS,
  picker: false,
  holders: 0,
  toast: "",
};

export function usePositionEngine(props: PositionProps) {
  const { nickname, status, side, leverage, creatorFeeBps, collateralized, onBuy } = props;

  const cfg = useMemo<PositionConfig>(
    () => ({
      nickname: nickname || "Lunar Ladder",
      status: status || "Open",
      side: side || "long",
      leverage: leverage ?? 5,
      creatorFeeBps: creatorFeeBps ?? 85,
      collateralized: collateralized ?? true,
    }),
    [nickname, status, side, leverage, creatorFeeBps, collateralized],
  );

  // deterministic, so both sides of hydration replay the same reports
  const series = useMemo(() => buildSeries(cfg.leverage), [cfg.leverage]);

  const [st, setSt] = useState<State>(INITIAL);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastT.current) clearTimeout(toastT.current);
    },
    [],
  );

  const flash = useCallback((toast: string) => {
    setSt((s) => ({ ...s, toast }));
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setSt((s) => ({ ...s, toast: "" })), 2600);
  }, []);

  const vals = useMemo(() => derive(series, st, cfg), [series, st, cfg]);

  const setRange = useCallback((range: RangeKey) => setSt((s) => ({ ...s, range })), []);
  const setAmount = useCallback((amount: string) => setSt((s) => ({ ...s, amount })), []);
  const togglePicker = useCallback(() => setSt((s) => ({ ...s, picker: !s.picker })), []);

  /** Reactions drop off the row once nobody is left holding them. */
  const toggleReact = useCallback(
    (i: number) =>
      setSt((s) => ({
        ...s,
        reacts: s.reacts
          .map((y, k) => (k !== i ? y : { ...y, mine: !y.mine, count: y.count + (y.mine ? -1 : 1) }))
          .filter((y) => y.count > 0),
      })),
    [],
  );

  /** Picking an emoji already on the row joins it rather than adding a second. */
  const addReact = useCallback(
    (emoji: string) =>
      setSt((s) => {
        const hit = s.reacts.find((x) => x.emoji === emoji);
        const reacts: Reaction[] = hit
          ? s.reacts.map((x) => (x.emoji !== emoji ? x : { ...x, mine: true, count: x.count + (x.mine ? 0 : 1) }))
          : s.reacts.concat([{ emoji, count: 1, mine: true, who: "you" }]);
        return { ...s, reacts, picker: false };
      }),
    [],
  );

  const buy = useCallback(() => {
    if (vals.buyDisabled) return;
    if (onBuy) {
      // same parse derive() applies to the ticket's amount
      const amt = parseFloat(String(st.amount).replace(/[^0-9.]/g, "")) || 0;
      flash("Confirm in your wallet…");
      onBuy(amt).then(flash, (e: unknown) =>
        flash(e instanceof Error ? e.message.split("\n")[0] : "Buy-in failed"),
      );
      return;
    }
    setSt((s) => ({ ...s, holders: s.holders + 1 }));
    flash(vals.buyToast);
  }, [vals.buyDisabled, vals.buyToast, flash, onBuy, st.amount]);

  return { st, vals, series, palette: PALETTE, setRange, setAmount, togglePicker, toggleReact, addReact, buy, flash };
}

export type PositionEngine = ReturnType<typeof usePositionEngine>;
