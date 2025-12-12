import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import {
  placeHyperliquidOrder,
  fetchHyperliquidClearinghouseState,
  type HyperliquidOrderResponse,
} from "opentool/adapters/hyperliquid";
import type { WalletFullContext } from "opentool/wallet";

import {
  profile,
  resolveChainConfig,
  computeSmaFromGateway,
  extractOrderIds,
  formatMarketablePrice,
  MARKET_SLIPPAGE_BPS,
} from "../src/utils";

export { profile };

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

  const actions: Array<() => Promise<HyperliquidOrderResponse>> = [];

  if (crossedDown && hasLong) {
    const price = formatMarketablePrice(
      signal.latestPrice,
      "sell",
      MARKET_SLIPPAGE_BPS
    ); // cross down -> sell slightly below to ensure fill
    // Close existing long
    actions.push(async () => {
      return await placeHyperliquidOrder({
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
      return await placeHyperliquidOrder({
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

  const orderResponses: HyperliquidOrderResponse[] = [];
  for (const act of actions) {
    const res = await act();
    orderResponses.push(res);
  }

  const orderIds = extractOrderIds(orderResponses);
  const ref =
    orderIds.cloids[0] ??
    orderIds.oids[0] ??
    `sma-${symbol}-${Date.now()}`;

  // Record outcome
  await store({
    source: "hyperliquid",
    ref,
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
      orderIds,
      orderResponses: orderResponses.length ? orderResponses : undefined,
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
