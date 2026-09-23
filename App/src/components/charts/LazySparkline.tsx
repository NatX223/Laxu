"use client";

import dynamic from "next/dynamic";

/** Sparkline, client-side only — Lightweight Charts touches `window`. */
const LazySparkline = dynamic(() => import("./Sparkline"), { ssr: false });

export default LazySparkline;
