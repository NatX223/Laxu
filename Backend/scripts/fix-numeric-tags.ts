/**
 * One-off: give every user whose tag contains a digit (the old `[a-z0-9_]`
 * rule, e.g. `swift_otter_4821`) a fresh letters-only tag from the same
 * generator new users get. Letters-only tags are left alone, so it is safe to
 * re-run.
 *
 *   npm run tags:fix
 */

import { db } from "../src/config/db";
import { createLogger, errorFields } from "../src/lib/logger";
import { allocateTag, hasDigit, isTagCollision } from "../src/services/tags";

const log = createLogger("fix-numeric-tags");

async function main(): Promise<void> {
  const users = await db.user.findMany({ select: { walletAddress: true, tag: true } });
  const stale = users.filter((user) => hasDigit(user.tag));
  log.info("users with numeric tags", { total: users.length, toFix: stale.length });

  for (const { walletAddress, tag: oldTag } of stale) {
    const tag = await allocateTag(async (candidate) => {
      try {
        await db.user.update({ where: { walletAddress }, data: { tag: candidate } });
        return candidate;
      } catch (error) {
        if (isTagCollision(error)) return "taken";
        throw error;
      }
    });
    log.info("retagged", { walletAddress, from: oldTag, to: tag });
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    log.error("fix-numeric-tags failed", errorFields(error));
    await db.$disconnect();
    process.exit(1);
  });
