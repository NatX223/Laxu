import { db } from "../src/config/db";
import { createLogger, errorFields } from "../src/lib/logger";
import { syncMarkets } from "../src/services/marketSync";

const log = createLogger("seed");

/**
 * Markets are no longer a hard-coded list: they sync live from Arcus
 * `GET /v1/markets` (the backend also does this at boot and every minute). The
 * seed just runs one sync so a fresh database is usable straight away.
 */
async function main(): Promise<void> {
  const result = await syncMarkets();
  log.info("markets synced from Arcus", result);
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    log.error("seed failed", errorFields(error));
    await db.$disconnect();
    process.exit(1);
  });
