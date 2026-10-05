import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleOf } from "./discovery";


test("position lifecycle: open -> closing -> settling -> settled", () => {
  assert.equal(lifecycleOf("open", null), "open");
  assert.equal(lifecycleOf("open", "closing"), "closing");
  assert.equal(lifecycleOf("open", "withdrawing"), "settling");
  assert.equal(lifecycleOf("closed", "closing"), "settling");
  assert.equal(lifecycleOf("closed", null), "settling");
  assert.equal(lifecycleOf("closed", "settling"), "settling");
  assert.equal(lifecycleOf("settled", "settled"), "settled");
  assert.equal(lifecycleOf("settled", null), "settled");
});
