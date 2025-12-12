"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var utils_exports = {};
__export(utils_exports, {
  BARS_TO_CHECK: () => BARS_TO_CHECK,
  MARKET_SLIPPAGE_BPS: () => MARKET_SLIPPAGE_BPS,
  computeSmaFromGateway: () => computeSmaFromGateway,
  countDecimals: () => countDecimals,
  extractOrderIds: () => extractOrderIds,
  formatMarketablePrice: () => formatMarketablePrice,
  profile: () => profile,
  resolveChainConfig: () => resolveChainConfig
});
module.exports = __toCommonJS(utils_exports);
const BARS_TO_CHECK = 10;
const MARKET_SLIPPAGE_BPS = 50;
const profile = {
  description: "Long-only SMA strategy: every 10 minutes check SMA200 on 1m candles and flip between flat/long on crosses.",
  schedule: { cron: "*/10 * * * *", enabled: true },
  limits: { concurrency: 1 },
  symbol: "BTC-USDC",
  size: "100",
  environment: "testnet"
};
function countDecimals(value) {
  if (!Number.isFinite(value)) return 0;
  const s = value.toString();
  const [, dec = ""] = s.split(".");
  return dec.length;
}
function formatMarketablePrice(mid, side, slippageBps) {
  const decimals = countDecimals(mid);
  const factor = 10 ** decimals;
  const adjusted = mid * (side === "buy" ? 1 + slippageBps / 1e4 : 1 - slippageBps / 1e4);
  const scaled = adjusted * factor;
  const rounded = side === "buy" ? Math.ceil(scaled) / factor : Math.floor(scaled) / factor;
  return rounded.toString();
}
function resolveChainConfig(environment) {
  return environment === "mainnet" ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL } : {
    chain: "arbitrum-sepolia",
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL
  };
}
function extractOrderIds(responses) {
  const cloids = /* @__PURE__ */ new Set();
  const oids = /* @__PURE__ */ new Set();
  const push = (val, target) => {
    if (val === null || val === void 0) return;
    const str = String(val);
    if (str.length) target.add(str);
  };
  for (const res of responses) {
    const statuses = res?.response?.data?.statuses;
    if (!Array.isArray(statuses)) continue;
    for (const status of statuses) {
      const resting = status.resting;
      const filled = status.filled;
      push(resting?.cloid, cloids);
      push(resting?.oid, oids);
      push(filled?.cloid, cloids);
      push(filled?.oid, oids);
    }
  }
  return {
    cloids: Array.from(cloids),
    oids: Array.from(oids)
  };
}
async function computeSmaFromGateway(symbol) {
  const coin = symbol.split("-")[0] || symbol;
  const params = new URLSearchParams({
    symbol: coin,
    resolution: "1",
    // 1m bars
    countBack: "240",
    // a bit more than 200
    to: Math.floor(Date.now() / 1e3).toString()
  });
  const url = `https://gateway-staging.openpond.dev/v1/hyperliquid/bars?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch bars (${res.status}) from gateway (${url})`
    );
  }
  const json = await res.json().catch(() => null);
  const closes = (json?.bars ?? []).map((b) => b.close ?? b.c ?? 0).filter((v) => Number.isFinite(v));
  const minNeeded = 200 + BARS_TO_CHECK;
  if (closes.length < minNeeded) {
    throw new Error(
      `Not enough bars to compute SMA200 scan (need ${minNeeded} closes, got ${closes.length})`
    );
  }
  const samples = [];
  for (let offset = 0; offset < BARS_TO_CHECK; offset++) {
    const endIdx = closes.length - 1 - offset;
    const currWindow = closes.slice(endIdx - 199, endIdx + 1);
    const prevWindow = closes.slice(endIdx - 200, endIdx);
    if (currWindow.length < 200 || prevWindow.length < 200) {
      break;
    }
    const latestPrice2 = currWindow[currWindow.length - 1];
    const prevPrice2 = prevWindow[prevWindow.length - 1];
    const smaCurr2 = currWindow.reduce((acc, v) => acc + v, 0) / currWindow.length;
    const smaPrev2 = prevWindow.reduce((acc, v) => acc + v, 0) / prevWindow.length;
    const crossedUp = prevPrice2 <= smaPrev2 && latestPrice2 > smaCurr2;
    const crossedDown = prevPrice2 < smaPrev2 && latestPrice2 < smaCurr2;
    samples.push({
      offset,
      smaCurr: smaCurr2,
      smaPrev: smaPrev2,
      latestPrice: latestPrice2,
      prevPrice: prevPrice2,
      crossedUp,
      crossedDown
    });
  }
  if (samples.length === 0) {
    throw new Error("Unable to compute any SMA samples");
  }
  const { smaCurr, smaPrev, latestPrice, prevPrice } = samples[0];
  return {
    smaCurr,
    smaPrev,
    latestPrice,
    prevPrice,
    recentCloses: closes.slice(-BARS_TO_CHECK),
    samples
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BARS_TO_CHECK,
  MARKET_SLIPPAGE_BPS,
  computeSmaFromGateway,
  countDecimals,
  extractOrderIds,
  formatMarketablePrice,
  profile,
  resolveChainConfig
});
