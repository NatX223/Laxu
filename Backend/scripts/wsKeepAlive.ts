/**
 * Spec 06 Part 1 measurement: hold N slot trading sockets open with no orders
 * and record every close.
 *
 *   LOG_LEVEL=debug npx ts-node --transpile-only scripts/wsKeepAlive.ts --label idle --minutes 30 --slots 2
 *
 *   --label    names the output file (.e2e/ws-keepalive-<label>.json)
 *   --minutes  how long to hold the sockets (default 30)
 *   --slots    how many slot sockets (default 2); free slots with a Perpl account only
 *   --no-keep-awake  do not ask Windows to stay out of Modern Standby (default: ask)
 *
 * PERPL_WS_PING_MS (env) sets the application-ping period for the run; 0 turns
 * the mt:1 pings off, which is how hypothesis (b) "the server also wants our
 * pings" is tested against the default.
 *
 * Run it ONLY while no backend is running (one process holds a wallet's sockets
 * at a time: Perpl allows few connections per wallet/IP). It places no orders
 * and touches no money. Never prints a key.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { db } from "../src/config/db";
import { config } from "../src/config/env";
import { sleep } from "../src/lib/async";
import { closeAll, ensure } from "../src/venue/perpl/connections";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

interface CloseRecord {
  slot: string;
  atIso: string;
  at: number;
  code: number;
  reason: string;
  uptimeMs: number;
  msSinceLastServerPing: number | null;
  msSinceLastDataFrame: number | null;
  msSinceLastAppPingSent: number | null;
  msSinceLastAppPong: number | null;
  serverPings: number;
  pongsSent: number;
  appPingsSent: number;
  appPongsReceived: number;
  serverPingGapMs: number | null;
  sentLast60s: number;
}

/// ES_CONTINUOUS | ES_SYSTEM_REQUIRED for as long as the child lives: keeps an idle
/// PC out of Modern Standby, which froze the Phase 6 soak twice. Reverts when it exits.
function keepAwake(seconds: number): ChildProcess | undefined {
  if (process.platform !== "win32") return undefined;
  const script =
    "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
    `[void][W.P]::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds ${seconds}`;
  return spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

async function main() {
  const label = arg("--label", "idle");
  const minutes = Number(arg("--minutes", "30"));
  const slotCount = Number(arg("--slots", "2"));
  const awake = process.argv.includes("--no-keep-awake") ? undefined : keepAwake(Math.ceil(minutes * 60) + 120);

  const slots = await db.subaccountSlot.findMany({
    where: { status: "free", perplAccountId: { not: null } },
    include: { operatorWallet: true },
    orderBy: { id: "asc" },
    take: slotCount,
  });
  if (slots.length < slotCount) throw new Error(`only ${slots.length} free slot(s) with a Perpl account; wanted ${slotCount}`);

  const startedAt = Date.now();
  const closes: CloseRecord[] = [];
  const connections = slots.map((slot) => {
    const conn = ensure(slot);
    conn.on("closed", (e: CloseRecord & { slotId: string }) => {
      closes.push({ ...e, slot: e.slotId.slice(-6), atIso: new Date(e.at).toISOString() });
      console.log(`CLOSE ${new Date(e.at).toISOString()} slot ${e.slotId.slice(-6)} ${e.code} "${e.reason}" uptime ${Math.round(e.uptimeMs / 1000)}s serverPings ${e.serverPings} gap~${e.serverPingGapMs}ms sinceLastPing ${e.msSinceLastServerPing}ms`);
    });
    return conn;
  });
  console.log(`holding ${slots.length} trading socket(s) for ${minutes} min; app ping every ${config.perplWsPingMs} ms (0 = off); sockets: ${slots.map((s) => s.id.slice(-6)).join(", ")}`);

  // A frozen process (standby) shows up as a long gap between 1 s ticks.
  const stalls: Array<{ atIso: string; gapMs: number }> = [];
  let last = Date.now();
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - last > 10_000) stalls.push({ atIso: new Date(now).toISOString(), gapMs: now - last });
    last = now;
  }, 1_000);

  const endAt = startedAt + minutes * 60_000;
  let lastReport = 0;
  while (Date.now() < endAt) {
    await sleep(5_000);
    if (Date.now() - lastReport >= 60_000) {
      lastReport = Date.now();
      console.log(
        `t+${Math.round((Date.now() - startedAt) / 60_000)}m closes=${closes.length} ` +
          connections.map((c) => `${c.slotId.slice(-6)}:${c.status().state}`).join(" "),
      );
    }
  }
  clearInterval(watchdog);

  // Closes of two different sockets within 50 ms of each other.
  const sorted = [...closes].sort((a, b) => a.at - b.at);
  const simultaneous: Array<{ a: string; b: string; deltaMs: number }> = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i].at - sorted[i - 1].at;
    if (delta <= 50 && sorted[i].slot !== sorted[i - 1].slot) simultaneous.push({ a: sorted[i - 1].atIso, b: sorted[i].atIso, deltaMs: delta });
  }
  const perSocket: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const c of closes) {
    perSocket[c.slot] = (perSocket[c.slot] ?? 0) + 1;
    byCode[`${c.code} ${c.reason}`] = (byCode[`${c.code} ${c.reason}`] ?? 0) + 1;
  }
  const summary = {
    label,
    startedAt: new Date(startedAt).toISOString(),
    minutes: Math.round((Date.now() - startedAt) / 600) / 100,
    appPingMs: config.perplWsPingMs,
    sockets: slots.map((s) => s.id.slice(-6)),
    closesTotal: closes.length,
    closesPerSocket: perSocket,
    byCode,
    simultaneousPairs: simultaneous,
    processStalls: stalls,
    closes,
  };
  const out = resolve(__dirname, `../.e2e/ws-keepalive-${label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log("\nSUMMARY\n" + JSON.stringify({ ...summary, closes: undefined }, null, 2) + `\nwritten to ${out}`);

  closeAll();
  awake?.kill();
  await db.$disconnect();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error));
    closeAll();
    process.exit(1);
  },
);
