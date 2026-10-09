/**
 * Enroll a fresh Perpl API key for slot wallets (Spec 06 Part 4), from the
 * slot wallets' own EVM keys. Needs an Origin Perpl has whitelisted.
 *
 *   npx ts-node --transpile-only scripts/perpl/enrollSlotKey.ts --slot 1 --dry-run
 *   npx ts-node --transpile-only scripts/perpl/enrollSlotKey.ts --all --verify
 *
 * Flags:
 *   --slot N | --all        which slots (--all: every SECRET_SLOT_<n>_EVM set, n = 1..SLOT_COUNT, default 5)
 *   --scope 1|2|3           1 read, 2 trade, 3 both (default 3)
 *   --label "laxu-slot-{n}-v2"   {n} becomes the slot number
 *   --builder-id N --max-fee N   bind the key to builder code N with fee ceiling N per 100k (0..100)
 *   --dry-run               request the payload only; print its statement and fields; sign and submit nothing
 *   --verify                after enrolling, one signed read + one trading-socket sign-in with the new key
 *   --verify-only           verify the keys already in --out; enroll nothing
 *   --out <path>            default ./secrets/slot-keys.json (0600, gitignored)
 *
 * Env: PERPL_ENROLL_ORIGIN (required), SECRET_SLOT_<n>_EVM, PERPL_API_URL,
 * PERPL_WS_URL, PERPL_CHAIN_ID. Never prints a key or token: the new values
 * go to --out only, and the script prints the variable names to copy.
 */
import { config } from "../../src/config/env";
import { runEnrollSlots } from "../../src/venue/perpl/enrollSlots";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function intArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) fail(`--${name} must be a whole number`);
  return Number(raw);
}

async function main(): Promise<void> {
  const slotCount = Number(process.env.SLOT_COUNT || 5);
  const one = intArg("slot");
  const slots = flag("all")
    ? Array.from({ length: slotCount }, (_, i) => i + 1).filter((n) => process.env[`SECRET_SLOT_${n}_EVM`])
    : one !== undefined
      ? [one]
      : fail("Pass --slot N or --all");
  if (slots.length === 0) fail("No SECRET_SLOT_<n>_EVM is set");

  const scope = intArg("scope") ?? 3;
  if (scope !== 1 && scope !== 2 && scope !== 3) fail("--scope must be 1, 2 or 3");

  const builderId = intArg("builder-id");
  const maxFee = intArg("max-fee");
  if (builderId !== undefined && (builderId < 1 || builderId > 255)) fail("--builder-id must be in 1..255");
  if (maxFee !== undefined && builderId === undefined) fail("--max-fee needs --builder-id");
  if (maxFee !== undefined && maxFee > 100) fail("--max-fee is at most 100 (0.1%)");
  if (maxFee && scope === 1) fail("a non-zero --max-fee needs the trade scope");

  const verifyOnly = flag("verify-only");
  const origin = process.env.PERPL_ENROLL_ORIGIN ?? "";
  if (!origin && !verifyOnly) fail("PERPL_ENROLL_ORIGIN is not set. Use the origin Perpl whitelisted for Laxu.");

  const result = await runEnrollSlots(
    {
      slots,
      scope,
      label: arg("label") ?? "laxu-slot-{n}-v2",
      builderId,
      maxBuilderFeePer100k: maxFee,
      dryRun: flag("dry-run"),
      verify: flag("verify"),
      verifyOnly,
      out: arg("out") ?? "./secrets/slot-keys.json",
      origin,
      apiUrl: config.perplApiUrl,
      wsUrl: config.perplWsUrl,
      chainId: config.perplChainId,
    },
    { print: (line) => console.log(line), evmKeyFor: (n) => process.env[`SECRET_SLOT_${n}_EVM`] },
  );
  console.log(`\n${result.ok} ok, ${result.failed} failed`);
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((error) => fail(`enrollSlotKey failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`));
