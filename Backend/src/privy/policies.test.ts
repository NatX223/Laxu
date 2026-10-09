import assert from "node:assert/strict";
import test from "node:test";

import { buildRepayPolicy } from "./policies";

const POOL = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc"; // lowercase on purpose: stored rows are lowercase
const CHECKSUMMED = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";

test("repay policy: exact shape (this JSON is quoted in docs/privy-integration.md)", () => {
  const policy = buildRepayPolicy({ pool: POOL, maxPerCall: 50_000_000n, chainId: 10143 }, "quorum_id");
  assert.deepEqual(policy, {
    name: "laxu-repay-0xa9012a05",
    version: "1.0",
    chain_type: "ethereum",
    owner_id: "quorum_id",
    rules: [
      {
        name: "allow repay(amount <= maxPerCall) on this pool only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: CHECKSUMMED },
          { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "10143" },
          { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "0x0" },
          {
            field_source: "ethereum_calldata",
            field: "function_name",
            abi: policy.rules[0].conditions[3].abi,
            operator: "eq",
            value: "repay",
          },
          {
            field_source: "ethereum_calldata",
            field: "repay.amount",
            abi: policy.rules[0].conditions[4].abi,
            operator: "lte",
            value: "0x2faf080", // 50_000_000
          },
        ],
      },
    ],
  });
});

test("repay policy: one ALLOW rule, no DENY (a DENY-all would override the ALLOW), and the ABI is repay only", () => {
  const policy = buildRepayPolicy({ pool: POOL, maxPerCall: 1n, chainId: 10143 }, "q");
  assert.equal(policy.rules.length, 1);
  assert.ok(policy.rules.every((rule) => rule.action === "ALLOW"));
  for (const condition of policy.rules[0].conditions.filter((c) => c.field_source === "ethereum_calldata")) {
    const abi = condition.abi as Array<{ name: string }>;
    assert.deepEqual(abi.map((entry) => entry.name), ["repay"]);
  }
});

test("repay policy: the cap is hex of the exact base-unit amount, and a different pool changes only the target", () => {
  const cap = (n: bigint) =>
    buildRepayPolicy({ pool: POOL, maxPerCall: n, chainId: 10143 }, "q").rules[0].conditions[4].value;
  assert.equal(cap(1n), "0x1");
  assert.equal(cap(255n), "0xff");
  assert.equal(cap(500_000_000n), "0x1dcd6500");

  const other = buildRepayPolicy({ pool: "0x000000000000000000000000000000000000dEaD", maxPerCall: 1n, chainId: 10143 }, "q");
  assert.equal(other.rules[0].conditions[0].value, "0x000000000000000000000000000000000000dEaD");
});

test("repay policy: refuses something that is not an address", () => {
  assert.throws(() => buildRepayPolicy({ pool: "nope", maxPerCall: 1n, chainId: 10143 }, "q"));
});
