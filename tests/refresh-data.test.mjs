import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wan = {
  name: "Wanchain Testnet", chain: "WAN", chainId: 999, networkId: 999,
  nativeCurrency: { name: "Wancoin", symbol: "WAN", decimals: 18 },
  rpc: ["https://gwan-ssl.wandevs.org:46891/"],
};
const hype = {
  name: "HyperEVM", chain: "HyperEVM", slug: "hyperevm", chainId: 999, networkId: null,
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpc: ["https://rpc.hyperliquid.xyz/evm"],
};
const ethereum = {
  name: "Ethereum Mainnet", chain: "ETH", chainId: 1, networkId: 1,
  rpc: ["https://existing.example", "https://ethereum.drpc.org"],
};
const provider = (name, chainId) => ({ name, chain_id: chainId, has_free: true });

// Run the actual refresh entrypoint. Only its two catalog reads are stubbed;
// all parsing, numeric overrides, provider injection and output are unchanged.
function refresh({ networks = [wan], providers = [provider("hyperliquid", "0x3e7")], overrides = {}, explicit = [] } = {}) {
  const temporaryRoot = join(root, ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, "refresh-data-test-"));
  try {
    copyFileSync(join(root, "refresh-data.ts"), join(directory, "refresh-data.ts"));
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "override-chain-names.json"), "{}");
    writeFileSync(join(directory, "override-networks.json"), JSON.stringify(explicit));
    writeFileSync(join(directory, "override-rpc.json"), JSON.stringify(overrides));
    writeFileSync(join(directory, "inputs.json"), JSON.stringify({ networks, providers }));
    writeFileSync(join(directory, "catalog-stub.mjs"), `
import https from "node:https";
import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
const inputs = JSON.parse(readFileSync(new URL("./inputs.json", import.meta.url)));
const calls = [];
const rejectNetwork = () => { throw new Error("Unexpected live network request"); };
http.get = http.request = https.request = rejectNetwork;
globalThis.fetch = rejectNetwork;
https.get = (url, callback) => {
  const key = String(url);
  let data;
  if (key === "https://chainid.network/chains.json") data = inputs.networks;
  else if (key === "https://lb.drpc.org/networks") data = [{ chains: inputs.providers }];
  else return rejectNetwork();
  calls.push(key);
  const request = new EventEmitter();
  queueMicrotask(() => {
    const response = new EventEmitter();
    callback(response);
    response.emit("data", JSON.stringify(data));
    response.emit("end");
  });
  return request;
};
process.on("exit", () => writeFileSync(new URL("./catalog-calls.json", import.meta.url), JSON.stringify(calls)));
`);
    const result = spawnSync(process.execPath, ["--import", join(directory, "catalog-stub.mjs"), join(directory, "refresh-data.ts")], {
      cwd: directory, encoding: "utf8", timeout: 8000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "catalog-calls.json"), "utf8")), [
      "https://chainid.network/chains.json", "https://lb.drpc.org/networks",
    ]);
    return JSON.parse(readFileSync(join(directory, "chains.generated.json"), "utf8")).flatMap((chain) => chain.networks);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const byName = (networks, name) => networks.find((network) => network.name === name);

test("Wanchain 999 does not receive HyperEVM's provider endpoint", () => {
  assert.deepEqual(byName(refresh(), wan.name).rpc, wan.rpc);
});

test("a legacy 999 numeric override cannot identify either network", () => {
  const result = refresh({ overrides: { 999: ["https://wrong-network.example"] } });
  assert.deepEqual(byName(result, wan.name).rpc, wan.rpc);
});

test("provider ordering or duplicate 999 entries cannot select a network", () => {
  const providers = [provider("hyperliquid", "0x3e7"), provider("wanchain-testnet", 999)];
  for (const ordered of [providers, [...providers].reverse()]) {
    assert.deepEqual(byName(refresh({ providers: ordered }), wan.name).rpc, wan.rpc);
  }
});

test("renaming a provider does not make its numeric ID sufficient", () => {
  const result = refresh({ providers: [provider("unreviewed-name", 999)] });
  assert.deepEqual(byName(result, wan.name).rpc, wan.rpc);
});

test("an explicit HyperEVM identity keeps only its explicitly supplied RPCs", () => {
  const result = refresh({ explicit: [hype], overrides: { 999: ["https://wrong-network.example"] } });
  assert.deepEqual(byName(result, hype.name), hype);
  assert.deepEqual(byName(result, wan.name).rpc, wan.rpc);
});

test("a primary-source HyperEVM 999 also receives no numeric injection", () => {
  const result = refresh({ networks: [wan, hype], overrides: { 999: ["https://wrong-network.example"] } });
  assert.deepEqual(byName(result, wan.name).rpc, wan.rpc);
  assert.deepEqual(byName(result, hype.name).rpc, hype.rpc);
});

test("unambiguous IDs retain provider ordering and override deduplication", () => {
  const result = refresh({
    networks: [ethereum], providers: [provider("ethereum", "0x1")],
    overrides: { 1: ["https://custom.example", "https://existing.example"] },
  });
  assert.deepEqual(byName(result, ethereum.name).rpc, [
    "https://ethereum.drpc.org", "https://custom.example", "https://existing.example",
  ]);
});

test("networks with no chain ID retain their source endpoints", () => {
  const network = { ...ethereum, name: "No ID", chainId: null };
  assert.deepEqual(byName(refresh({ networks: [network] }), network.name).rpc, network.rpc);
});

test("chain ID zero retains the existing override and provider behavior", () => {
  const network = { ...ethereum, name: "Zero", chainId: 0, rpc: ["https://zero-source.example"] };
  const result = refresh({ networks: [network], providers: [provider("zero", 0)], overrides: { 0: ["https://zero-override.example"] } });
  assert.deepEqual(byName(result, network.name).rpc, ["https://zero.drpc.org", "https://zero-source.example"]);
});

test("the snapshot's incorrect Wanchain provider URL is absent", () => {
  const data = JSON.parse(readFileSync(join(root, "chains.generated.json"), "utf8"));
  const network = data.flatMap((chain) => chain.networks).find((entry) => entry.slug === "wanchain-testnet");
  assert.ok(network);
  assert.equal(network.rpc.includes("https://hyperliquid.drpc.org"), false);
  assert.ok(network.rpc.includes("https://gwan-ssl.wandevs.org:46891/"));
});
