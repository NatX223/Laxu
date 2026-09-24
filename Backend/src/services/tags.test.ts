import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../lib/errors";
import {
  ADJECTIVES,
  allocateTag,
  hasDigit,
  isTagCollision,
  normaliseTag,
  NOUNS,
  TAG_MAX,
  TAG_MIN,
  TAG_REGEX,
  threeWordTag,
  twoWordTag,
} from "./tags";

const valid = (tag: string) => TAG_REGEX.test(tag) && tag.length >= TAG_MIN && tag.length <= TAG_MAX;

test("word lists: 150+ unique lowercase words of at most 8 letters", () => {
  for (const list of [ADJECTIVES, NOUNS]) {
    assert.ok(list.length >= 150, `only ${list.length} words`);
    assert.equal(new Set(list).size, list.length, "duplicate word");
    for (const word of list) assert.match(word, /^[a-z]{2,8}$/);
  }
});

test("1,000 generated tags are all valid and digit-free", () => {
  for (let i = 0; i < 1000; i++) {
    for (const tag of [twoWordTag(), threeWordTag()]) {
      assert.ok(valid(tag), `invalid tag ${tag}`);
      assert.equal(hasDigit(tag), false);
    }
  }
});

test("three-word tags use two different adjectives", () => {
  for (let i = 0; i < 200; i++) {
    const [a, b] = threeWordTag().split("_");
    assert.notEqual(a, b);
  }
});

test("collisions retry two-word tags 5 times, then three-word tags", async () => {
  const seen: string[] = [];
  const tag = await allocateTag(async (candidate) => {
    seen.push(candidate);
    return seen.length < 8 ? "taken" : candidate;
  });
  assert.equal(seen.length, 8);
  assert.deepEqual(
    seen.map((t) => t.split("_").length),
    [2, 2, 2, 2, 2, 3, 3, 3],
  );
  assert.equal(tag, seen[7]);
});

test("all 10 attempts taken is a 503", async () => {
  let calls = 0;
  await assert.rejects(
    allocateTag(async () => {
      calls++;
      return "taken";
    }),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
  assert.equal(calls, 10);
});

test("PATCH rule rejects digits, edge or double underscores and bad lengths", () => {
  const cases: [string, string][] = [
    ["otter1", "INVALID_TAG_CHARS"],
    ["swift otter", "INVALID_TAG_CHARS"],
    ["_otter", "INVALID_TAG_UNDERSCORE"],
    ["otter_", "INVALID_TAG_UNDERSCORE"],
    ["swift__otter", "INVALID_TAG_UNDERSCORE"],
    ["ab", "INVALID_TAG_LENGTH"],
    ["a".repeat(21), "INVALID_TAG_LENGTH"],
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => normaliseTag(input),
      (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === code,
      input,
    );
  }
});

test("PATCH rule lowercases before checking", () => {
  assert.equal(normaliseTag("Swift_Otter"), "swift_otter");
  assert.equal(normaliseTag("@quiet_blue_fox"), "quiet_blue_fox");
  assert.equal(normaliseTag("a".repeat(20)), "a".repeat(20));
});

test("the fix script only picks up tags with digits", () => {
  assert.equal(hasDigit("swift_otter_4821"), true);
  assert.equal(hasDigit("swift_otter"), false);
  assert.equal(hasDigit("quiet_blue_fox"), false);
});

test("only a unique violation on tag counts as a collision", () => {
  assert.equal(isTagCollision({ code: "P2002", meta: { target: ["tag"] } }), true);
  assert.equal(isTagCollision({ code: "P2002", meta: { target: "users_tag_key" } }), true);
  assert.equal(isTagCollision({ code: "P2002", meta: { target: ["wallet_address"] } }), false);
  assert.equal(isTagCollision(new Error("boom")), false);
});
