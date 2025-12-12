import type {
  HyperliquidOrderResponse,
  HyperliquidOrderStatus,
} from "opentool/adapters/hyperliquid";

export const BARS_TO_CHECK = 10; // number of 1m candles to scan each run (10 minutes)
export const MARKET_SLIPPAGE_BPS = 50; // 0.50% buffer to satisfy non-zero price requirement on market orders

export const profile = {
  description:
    "Long-only SMA strategy: every 10 minutes check SMA200 on 1m candles and flip between flat/long on crosses.",
  schedule: { cron: "*/10 * * * *", enabled: true },
  limits: { concurrency: 1 },
  symbol: "BTC-USDC",
  size: "100",
  environment: "testnet",
};

export function countDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const s = value.toString();
  const [, dec = ""] = s.split(".");
  return dec.length;
}

export function formatMarketablePrice(
  mid: number,
  side: "buy" | "sell",
  slippageBps: number
): string {
  const decimals = countDecimals(mid);
  const factor = 10 ** decimals;
  const adjusted =
    mid *
    (side === "buy"
      ? 1 + slippageBps / 10_000
      : 1 - slippageBps / 10_000);
  // Round in the direction that preserves marketability (ceil for buys, floor for sells)
  const scaled = adjusted * factor;
  const rounded =
    side === "buy" ? Math.ceil(scaled) / factor : Math.floor(scaled) / factor;
  return rounded.toString();
}

export function resolveChainConfig(environment: "mainnet" | "testnet"): {
  chain: string;
  rpcUrl: string | undefined;
} {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : {
        chain: "arbitrum-sepolia",
        rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
      };
}

export function extractOrderIds(responses: HyperliquidOrderResponse[]): {
  cloids: string[];
  oids: string[];
} {
  const cloids = new Set<string>();
  const oids = new Set<string>();
  const push = (val: unknown, target: Set<string>) => {
    if (val === null || val === undefined) return;
    const str = String(val);
    if (str.length) target.add(str);
  };
  for (const res of responses) {
    const statuses = (res as any)?.response?.data?.statuses as
      | HyperliquidOrderStatus[]
      | undefined;
    if (!Array.isArray(statuses)) continue;
    for (const status of statuses) {
      const resting = (status as any).resting;
      const filled = (status as any).filled;
      push(resting?.cloid, cloids);
      push(resting?.oid, oids);
      push(filled?.cloid, cloids);
      push(filled?.oid, oids);
    }
  }
  return {
    cloids: Array.from(cloids),
    oids: Array.from(oids),
  };
}

export async function computeSmaFromGateway(
  symbol: string
): Promise<{
  smaCurr: number;
  smaPrev: number;
  latestPrice: number;
  prevPrice: number;
  recentCloses: number[];
  samples: Array<{
    offset: number;
    smaCurr: number;
    smaPrev: number;
    latestPrice: number;
    prevPrice: number;
    crossedUp: boolean;
    crossedDown: boolean;
  }>;
}> {
  const coin = symbol.split("-")[0] || symbol;

  const params = new URLSearchParams({
    symbol: coin,
    resolution: "1", // 1m bars
    countBack: "240", // a bit more than 200
    to: Math.floor(Date.now() / 1000).toString(),
  });

  const url = `https://gateway-staging.openpond.dev/v1/hyperliquid/bars?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch bars (${res.status}) from gateway (${url})`
    );
  }

  const json = (await res.json().catch(() => null)) as {
    bars?: Array<{ close?: number; c?: number }>;
  } | null;

  const closes = (json?.bars ?? [])
    .map((b) => b.close ?? b.c ?? 0)
    .filter((v) => Number.isFinite(v));

  const minNeeded = 200 + BARS_TO_CHECK; // 200 for SMA + 10-bar scan window
  if (closes.length < minNeeded) {
    throw new Error(
      `Not enough bars to compute SMA200 scan (need ${minNeeded} closes, got ${closes.length})`
    );
  }

  const samples: Array<{
    offset: number;
    smaCurr: number;
    smaPrev: number;
    latestPrice: number;
    prevPrice: number;
    crossedUp: boolean;
    crossedDown: boolean;
  }> = [];

  for (let offset = 0; offset < BARS_TO_CHECK; offset++) {
    const endIdx = closes.length - 1 - offset;
    const currWindow = closes.slice(endIdx - 199, endIdx + 1); // 200 bars ending at endIdx
    const prevWindow = closes.slice(endIdx - 200, endIdx); // 200 bars ending at endIdx - 1
    if (currWindow.length < 200 || prevWindow.length < 200) {
      break;
    }

    const latestPrice = currWindow[currWindow.length - 1];
    const prevPrice = prevWindow[prevWindow.length - 1];
    const smaCurr =
      currWindow.reduce((acc, v) => acc + v, 0) / currWindow.length;
    const smaPrev =
      prevWindow.reduce((acc, v) => acc + v, 0) / prevWindow.length;

    const crossedUp = prevPrice <= smaPrev && latestPrice > smaCurr;
    const crossedDown = prevPrice < smaPrev && latestPrice < smaCurr;

    samples.push({
      offset,
      smaCurr,
      smaPrev,
      latestPrice,
      prevPrice,
      crossedUp,
      crossedDown,
    });
  }

  if (samples.length === 0) {
    throw new Error("Unable to compute any SMA samples");
  }

  // Most recent sample is offset 0
  const { smaCurr, smaPrev, latestPrice, prevPrice } = samples[0];

  return {
    smaCurr,
    smaPrev,
    latestPrice,
    prevPrice,
    recentCloses: closes.slice(-BARS_TO_CHECK),
    samples,
  };
}
