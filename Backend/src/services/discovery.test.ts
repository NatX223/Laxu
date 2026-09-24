import assert from "node:assert/strict";
import test from "node:test";

import { toUsdg6 } from "../lib/units";
import { compareSortable, matchesQuery, netDeposited, paginate, type Sortable } from "./discovery";

test("cursor pagination returns every item exactly once, in order, with ties", () => {
  // 57 items over 7 distinct key values -> lots of ties broken by id.
  const items: Sortable[] = Array.from({ length: 57 }, (_, i) => ({
    id: `pos-${String(i).padStart(3, "0")}`,
    keys: [BigInt(i % 7), BigInt((i * 13) % 5)],
  }));

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const { page, nextCursor } = paginate(items, 10, cursor);
    seen.push(...page.map((item) => item.id));
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, items.length);
  const expected = [...items].sort(compareSortable).map((item) => item.id);
  assert.deepEqual(seen, expected);
});

test("the last page has no next cursor", () => {
  const items: Sortable[] = [{ id: "a", keys: [1n] }, { id: "b", keys: [2n] }];
  assert.equal(paginate(items, 2).nextCursor, null);
  assert.deepEqual(
    paginate(items, 2).page.map((i) => i.id),
    ["b", "a"],
  );
});

test("search matches creator tag, symbol and nickname, case-insensitively", () => {
  const fields = {
    displaySymbol: "NVDA-USD",
    baseAsset: "NVDA",
    nickname: "Degen Dad",
    creator: "0xabc0000000000000000000000000000000000001",
    tag: "swift_otter_4821",
  };
  assert.equal(matchesQuery("otter", fields), true);
  assert.equal(matchesQuery("@swift", fields), true);
  assert.equal(matchesQuery("nvda", fields), true);
  assert.equal(matchesQuery("degen", fields), true);
  assert.equal(matchesQuery("0xABC", fields), true);
  assert.equal(matchesQuery("tsla", fields), false);
});

test("cost basis counts gross in-flows and redeem out-flows", () => {
  const net = netDeposited([
    { type: "buy_in", assets: toUsdg6("98").toString(), feeAssets: toUsdg6("2").toString() },
    { type: "top_up", assets: toUsdg6("10").toString(), feeAssets: "0" },
    { type: "redeem", assets: toUsdg6("30").toString(), feeAssets: "0" },
  ]);
  assert.equal(net, toUsdg6("80"));
});
