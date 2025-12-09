import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import {
  placeHyperliquidOrder,
  fetchHyperliquidClearinghouseState,
} from "opentool/adapters/hyperliquid";
import type { WalletFullContext } from "opentool/wallet";

const BARS_TO_CHECK = 10; // number of 1m candles to scan each run (10 minutes)
const MARKET_SLIPPAGE_BPS = 50; // 0.50% buffer to satisfy non-zero price requirement on market orders

function countDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const s = value.toString();
  const [, dec = ""] = s.split(".");
  return dec.length;
}

function formatMarketablePrice(
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

function resolveChainConfig(environment: "mainnet" | "testnet") {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : {
        chain: "arbitrum-sepolia",
        rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
      };
}

export const profile = {
  description:
    "Long-only SMA strategy: every 10 minutes check SMA200 on 1m candles and flip between flat/long on crosses.",
  schedule: { cron: "*/10 * * * *", enabled: true },
  limits: { concurrency: 1 },
  symbol: "BTC-USDC",
  size: "100",
  environment: "testnet",
};

export async function GET(_req: Request): Promise<Response> {
  const { symbol, size } = profile;
  const environment = "testnet";
  const chainConfig = resolveChainConfig(environment);
  const ctx = await wallet({ chain: chainConfig.chain });

  // Fetch SMA snapshots for the latest 10 one-minute candles (to avoid missing a cross between runs)
  const { samples, recentCloses } = await computeSmaFromGateway(symbol);
  const signal =
    samples.find((s) => s.crossedUp || s.crossedDown) ?? samples[0];
  const { smaCurr, smaPrev, latestPrice, prevPrice } = signal;

  // Fetch current position from clearinghouse (source of truth)
  const clearing = await fetchHyperliquidClearinghouseState({
    environment,
    walletAddress: ctx.address as `0x${string}`,
  });
  const assetPositions =
    (clearing as any)?.data?.assetPositions ??
    (clearing as any)?.assetPositions;
  if (!Array.isArray(assetPositions)) {
    throw new Error(
      `Hyperliquid clearinghouseState did not return assetPositions (got keys: ${Object.keys(
        (clearing as any)?.data ?? clearing ?? {}
      ).join(",")})`
    );
  }
  const currentSizeRaw =
    assetPositions.find((p: any) => {
      const coin = typeof p.coin === "string" ? p.coin : p?.position?.coin;
      return typeof coin === "string"
        ? coin.toUpperCase().startsWith(symbol.split("-")[0].toUpperCase())
        : false;
    })?.szi ??
    assetPositions.find((p: any) => {
      const coin = typeof p.coin === "string" ? p.coin : p?.position?.coin;
      return typeof coin === "string"
        ? coin.toUpperCase().startsWith(symbol.split("-")[0].toUpperCase())
        : false;
    })?.position?.szi ??
    0;
  const currentSize = Number.parseFloat(String(currentSizeRaw)) || 0;
  const hasLong = currentSize > 0;

  // Detect cross using each candle's own SMA (traditional definition):
  // - smaPrev: SMA200 ending at the previous close
  // - smaCurr: SMA200 ending at the latest close
  // Cross up when prev close is at/below its SMA and latest close is above its SMA.
  // Exit rule (two-bar guard): if already long, exit when the last two closes are below their SMAs.
  const crossedUp = signal.crossedUp;
  const crossedDown = hasLong && signal.crossedDown;

  const actions: Array<() => Promise<void>> = [];

  if (crossedDown && hasLong) {
    const price = formatMarketablePrice(
      signal.latestPrice,
      "sell",
      MARKET_SLIPPAGE_BPS
    ); // cross down -> sell slightly below to ensure fill
    // Close existing long
    actions.push(async () => {
      await placeHyperliquidOrder({
        wallet: ctx as WalletFullContext,
        environment,
        orders: [
          {
            symbol,
            side: "sell",
            price: price.toString(),
            size: Math.abs(currentSize).toString(),
            tif: "FrontendMarket",
            reduceOnly: true,
          },
        ],
      });
    });
  }

  if (crossedUp && !hasLong) {
    const price = formatMarketablePrice(
      signal.latestPrice,
      "buy",
      MARKET_SLIPPAGE_BPS
    ); // cross up -> buy slightly above to ensure fill
    // Open new long
    actions.push(async () => {
      await placeHyperliquidOrder({
        wallet: ctx as WalletFullContext,
        environment,
        orders: [
          {
            symbol,
            side: "buy",
            price: price.toString(),
            size,
            tif: "FrontendMarket",
            reduceOnly: false,
          },
        ],
      });
    });
  }

  for (const act of actions) {
    await act();
  }

  // Record outcome
  await store({
    source: "hyperliquid",
    ref: `sma-${symbol}-${Date.now()}`,
    status: actions.length ? "submitted" : "info",
    walletAddress: ctx.address,
    action: actions.length ? "order" : "noop",
    notional: actions.length ? size : undefined,
    network: "hyperliquid-testnet",
    metadata: {
      symbol,
      size,
      environment,
      sma200Curr: smaCurr,
      sma200Prev: smaPrev,
      latestPrice,
      prevPrice,
      crossedUp,
      crossedDown,
      hadLong: hasLong,
      actionsTaken: actions.length,
      signalOffsetMinutes: signal.offset,
      samplesChecked: samples.length,
      limitPriceUsed: actions.length ? signal.latestPrice : undefined,
    },
  });

  return Response.json({
    ok: true,
    actions: actions.length,
    crossedUp,
    crossedDown,
    sma200_1m: smaCurr,
    latestPrice,
    prevPrice,
    positionSize: currentSize,
    note: actions.length ? "orders placed" : "no action taken",
    signalOffsetMinutes: signal.offset,
    samplesChecked: samples.length,
  });
}

async function computeSmaFromGateway(
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
