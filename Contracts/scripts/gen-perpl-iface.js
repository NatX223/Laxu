// Prints the Solidity structs IPerplExchange needs, straight from Perpl's ABI, so the field order
// is never hand-typed. Source: PerplFoundation/dex-sdk@01b9910 crates/sdk/abi/dex/Exchange.json,
// vendored (abi only) at abi/perpl/Exchange.json.
//
//   node scripts/gen-perpl-iface.js            # print the structs
//   node scripts/gen-perpl-iface.js --check    # exit 1 if contracts/interfaces/IPerplExchange.sol differs
const fs = require("fs");
const path = require("path");

const { abi } = require(path.join(__dirname, "..", "abi", "perpl", "Exchange.json"));

const STRUCTS = [
  { fn: "getPerpetualInfo", name: "PerpetualInfo" },
  { fn: "getPosition", name: "PositionInfo" },
];

function structFor(fnName, structName) {
  const fn = abi.find((x) => x.type === "function" && x.name === fnName);
  if (!fn) throw new Error(`${fnName} not in ABI`);
  const tuple = fn.outputs.find((o) => o.type === "tuple");
  return { structName, fields: tuple.components.map((c) => [c.type, c.name]) };
}

const structs = STRUCTS.map((s) => structFor(s.fn, s.name));
const text = structs
  .map((s) => `    struct ${s.structName} {\n${s.fields.map(([t, n]) => `        ${t} ${n};`).join("\n")}\n    }`)
  .join("\n\n");

if (process.argv.includes("--check")) {
  const sol = fs.readFileSync(path.join(__dirname, "..", "contracts", "interfaces", "IPerplExchange.sol"), "utf8");
  const normalize = (x) => x.replace(/\s+/g, " ");
  const missing = structs.filter((s) => !normalize(sol).includes(normalize(text.split("\n\n")[structs.indexOf(s)])));
  if (missing.length) {
    console.error("IPerplExchange.sol is out of sync with the ABI for:", missing.map((s) => s.structName).join(", "));
    process.exit(1);
  }
  console.log("IPerplExchange.sol structs match abi/perpl/Exchange.json");
} else {
  console.log(text);
}
