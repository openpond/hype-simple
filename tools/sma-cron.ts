import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import {
  placeHyperliquidOrder,
  fetchHyperliquidClearinghouseState,
} from "opentool/adapters/hyperliquid";
import type { WalletFullContext } from "opentool/wallet";

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
  const { symbol, size, environment } = profile;
  const chainConfig = resolveChainConfig(environment);
  const ctx = await wallet({ chain: chainConfig.chain });

  // Fetch SMA and last two closes
  const { sma, latestPrice, prevPrice } = await computeSmaFromGateway(symbol);
  if (!Number.isFinite(sma) || !Number.isFinite(latestPrice) || !Number.isFinite(prevPrice)) {
    throw new Error("Unable to compute SMA or latest prices");
  }

  // Fetch current position from clearinghouse (source of truth)
  const clearing = await fetchHyperliquidClearinghouseState({
    environment,
    walletAddress: ctx.address as `0x${string}`,
  });
  const currentSizeRaw =
    clearing?.assetPositions?.find((p) =>
      typeof p.coin === "string" ? p.coin.toUpperCase().startsWith(symbol.split("-")[0].toUpperCase()) : false
    )?.szi ?? 0;
  const currentSize = Number.parseFloat(String(currentSizeRaw)) || 0;
  const hasLong = currentSize > 0;

  // Detect cross (long-only): cross up → go long, cross down → flat
  const crossedUp = prevPrice <= sma && latestPrice > sma;
  const crossedDown = prevPrice >= sma && latestPrice < sma;

  const actions: Array<() => Promise<void>> = [];

  if (crossedDown && hasLong) {
    // Close existing long
    actions.push(async () => {
      await placeHyperliquidOrder({
        wallet: ctx as WalletFullContext,
        environment,
        orders: [
          {
            symbol,
            side: "sell",
            price: "0",
            size: Math.abs(currentSize).toString(),
            tif: "FrontendMarket",
            reduceOnly: true,
          },
        ],
      });
    });
  }

  if (crossedUp && !hasLong) {
    // Open new long
    actions.push(async () => {
      await placeHyperliquidOrder({
        wallet: ctx as WalletFullContext,
        environment,
        orders: [
          {
            symbol,
            side: "buy",
            price: "0",
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
    source: "hyperliquid-sma",
    ref: `sma-${symbol}-${Date.now()}`,
    status: actions.length ? "submitted" : "info",
    walletAddress: ctx.address,
    action: actions.length ? "order" : "noop",
    notional: actions.length ? size : null,
    network: environment === "mainnet" ? "hyperliquid" : "hyperliquid-testnet",
    metadata: {
      symbol,
      size,
      environment,
      sma200: sma,
      latestPrice,
      prevPrice,
      crossedUp,
      crossedDown,
      hadLong: hasLong,
      actionsTaken: actions.length,
    },
  });

  return Response.json({
    ok: true,
    actions: actions.length,
    crossedUp,
    crossedDown,
    sma200_1m: sma,
    latestPrice,
    prevPrice,
    positionSize: currentSize,
    note: actions.length ? "orders placed" : "no action taken",
  });
}

async function computeSmaFromGateway(
  symbol: string
): Promise<{ sma: number; latestPrice: number; prevPrice: number }> {
  const gatewayBase = process.env.OPENPOND_GATEWAY_URL?.replace(/\/$/, "");

  const coin = symbol.split("-")[0] || symbol;

  const params = new URLSearchParams({
    symbol: coin,
    resolution: "1", // 1m bars
    countBack: "240", // a bit more than 200
    to: Math.floor(Date.now() / 1000).toString(),
  });

  const url = `${gatewayBase}/v1/hyperliquid/bars?${params.toString()}`;
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

  if (closes.length < 200) {
    throw new Error("Not enough bars to compute SMA200");
  }

  const window = closes.slice(-200);
  const latestPrice = window[window.length - 1];
  const prevPrice = window[window.length - 2];
  const sma = window.reduce((acc, v) => acc + v, 0) / window.length;
  return { sma, latestPrice, prevPrice };
}
