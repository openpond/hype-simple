import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import {
  fetchHyperliquidClearinghouseState,
  fetchHyperliquidSpotClearinghouseState,
  placeHyperliquidOrder,
  updateHyperliquidLeverage,
  type HyperliquidEnvironment,
} from "opentool/adapters/hyperliquid";
import type { WalletFullContext } from "opentool/wallet";

function resolveChainConfig(environment: HyperliquidEnvironment) {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : {
        chain: "arbitrum-sepolia",
        rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
      };
}

export const profile = {
  description:
    "Delta-neutral hedge: align perp size to offset spot balance (long spot, short perp) on a schedule.",
  schedule: { cron: "*/5 * * * *", enabled: true },
  limits: { concurrency: 1 },
  perpSymbol: "BTC",
  spotSymbol: "BTC/USDC",
  environment: "testnet" as HyperliquidEnvironment,
  rebalanceThreshold: 0.001, // base units tolerance to avoid constant churn
  minFundingRate: 0, // require funding >= threshold to keep hedge; otherwise flatten perp
  orderType: "limit" as "limit" | "market",
  limitSlippageBps: 10, // limit guardrails: buy at mark*(1+slip), sell at mark*(1-slip)
  limitTif: "Ioc" as const,
  // Optional spot leg control (assumes Hyperliquid spot trading adapter is available).
  targetSpotSize: null as number | null, // base units target; null = do not trade spot
  spotOrderType: "limit" as "limit" | "market",
  spotLimitSlippageBps: 10,
  spotLimitTif: "Ioc" as const,
  spotRebalanceThreshold: 0.001,
  leverage: null as { value: number; mode: "cross" | "isolated" } | null,
  fundingTargetRate: 0.0001, // scale hedge up to this rate (per hour), flatten below minFundingRate
};

export async function GET(_req: Request): Promise<Response> {
  const {
    perpSymbol,
    spotSymbol,
    environment,
    rebalanceThreshold,
    minFundingRate,
    orderType,
    limitSlippageBps,
    limitTif,
    targetSpotSize,
    spotOrderType,
    spotLimitSlippageBps,
    spotLimitTif,
    spotRebalanceThreshold,
    leverage,
    fundingTargetRate,
  } = profile;
  const baseSymbol = perpSymbol.split("-")[0] || perpSymbol;
  const chainConfig = resolveChainConfig(environment);
  const ctx = await wallet({ chain: chainConfig.chain });

  const market = await fetchMarketStats(perpSymbol).catch(() => ({
    markPrice: null,
    fundingRate: null,
  }));
  const fundingEligible =
    market.fundingRate !== null && market.fundingRate >= minFundingRate;

  const [spotState, perpState] = await Promise.all([
    fetchHyperliquidSpotClearinghouseState({
      environment,
      user: ctx.address as `0x${string}`,
    }),
    fetchHyperliquidClearinghouseState({
      environment,
      walletAddress: ctx.address as `0x${string}`,
    }),
  ]);

  // Optional leverage setup for the perp leg.
  if (leverage) {
    await updateHyperliquidLeverage({
      wallet: ctx as WalletFullContext,
      environment,
      input: {
        symbol: perpSymbol,
        leverageMode: leverage.mode,
        leverage: leverage.value,
      },
    });
  }

  // Fetch decimal precision for sizing.
  const [perpDecimals, spotDecimals] = await Promise.all([
    fetchSizeDecimals(perpSymbol, environment, "perp").catch(() => null),
    fetchSizeDecimals(spotSymbol, environment, "spot").catch(() => null),
  ]);

  const spotSize = extractSpotSize(spotState, baseSymbol);
  const perpSize = extractPerpSize(perpState, baseSymbol);
  const hasSpotTarget = typeof targetSpotSize === "number" && Number.isFinite(targetSpotSize);

  const spotAdjustment =
    hasSpotTarget && targetSpotSize !== null
      ? targetSpotSize - spotSize
      : 0;
  const needsSpotRebalance =
    hasSpotTarget && Math.abs(spotAdjustment) > spotRebalanceThreshold;

  const normalizedSpotAdj = needsSpotRebalance
    ? normalizeSize(spotAdjustment, spotDecimals)
    : 0;
  const effectiveSpotRebalance = needsSpotRebalance && normalizedSpotAdj !== 0;

  let spotOrderResult: unknown = null;
  if (effectiveSpotRebalance) {
    const spotLimitPrice =
      spotOrderType === "limit" && market.markPrice
        ? computeLimitPrice(market.markPrice, spotAdjustment, spotLimitSlippageBps)
        : null;
    const tif = spotLimitPrice ? spotLimitTif : "FrontendMarket";
    spotOrderResult = await placeHyperliquidOrder({
      wallet: ctx as WalletFullContext,
      environment,
      orders: [
        {
          symbol: spotSymbol,
          side: spotAdjustment > 0 ? "buy" : "sell",
          price: spotLimitPrice ?? "0",
          size: Math.abs(normalizedSpotAdj).toString(),
          tif,
          reduceOnly: false,
        },
      ],
    });
  }

  const projectedSpot = effectiveSpotRebalance ? spotSize + normalizedSpotAdj : spotSize;

  // Hedge target: perp position should offset spot (long spot -> short perp) only if funding is acceptable.
  const fundingScale =
    fundingEligible && fundingTargetRate > minFundingRate && market.fundingRate !== null
      ? Math.min(1, (market.fundingRate - minFundingRate) / (fundingTargetRate - minFundingRate))
      : fundingEligible
      ? 1
      : 0;
  const targetPerp = fundingEligible ? -projectedSpot * Math.max(0, Math.min(1, fundingScale)) : 0;
  const rawAdjustment = targetPerp - perpSize;
  const needsRebalance = Math.abs(rawAdjustment) > rebalanceThreshold;
  const normalizedPerpAdj = needsRebalance
    ? normalizeSize(rawAdjustment, perpDecimals)
    : 0;
  const effectivePerpRebalance = needsRebalance && normalizedPerpAdj !== 0;

  let orderResult: unknown = null;
  if (effectivePerpRebalance) {
    const limitPrice =
      orderType === "limit" && market.markPrice
        ? computeLimitPrice(market.markPrice, normalizedPerpAdj, limitSlippageBps)
        : null;
    const tif = limitPrice ? limitTif : "FrontendMarket";
    orderResult = await placeHyperliquidOrder({
      wallet: ctx as WalletFullContext,
      environment,
      orders: [
        {
          symbol: perpSymbol,
          side: normalizedPerpAdj > 0 ? "buy" : "sell",
          price: limitPrice ?? "0",
          size: Math.abs(normalizedPerpAdj).toString(),
          tif,
          reduceOnly: false,
        },
      ],
    });
  }

  await store({
    source: "hyperliquid",
    ref: `delta-neutral-${baseSymbol}-${Date.now()}`,
    status: needsRebalance ? "submitted" : "info",
    walletAddress: ctx.address,
    action: needsRebalance ? "order" : "noop",
    notional:
      market.markPrice && needsRebalance
        ? (Math.abs(normalizedPerpAdj) * market.markPrice).toString()
        : undefined,
    network: `hyperliquid-${environment}`,
    metadata: {
      perpSymbol,
      spotSymbol,
      baseSymbol,
      environment,
      spotSize,
      projectedSpot,
      perpSize,
      targetPerp,
      adjustment: normalizedPerpAdj,
      rebalanceThreshold,
      minFundingRate,
      orderType,
      limitSlippageBps,
      fundingTargetRate,
      targetSpotSize,
      spotAdjustment: normalizedSpotAdj,
      needsSpotRebalance: effectiveSpotRebalance,
      spotOrderType,
      spotLimitSlippageBps,
      needsRebalance: effectivePerpRebalance,
      markPrice: market.markPrice,
      fundingRate: market.fundingRate,
      fundingEligible,
      perpDecimals,
      spotDecimals,
      fundingScale,
      spotOrderResult,
      orderResult,
    },
  });

  return Response.json({
    ok: true,
    environment,
    baseSymbol,
    spotSize,
    projectedSpot,
    perpSize,
    targetPerp,
    adjustment: normalizedPerpAdj,
    orderType,
    limitSlippageBps,
    targetSpotSize,
    spotAdjustment: normalizedSpotAdj,
    needsSpotRebalance: effectiveSpotRebalance,
    spotOrderType,
    spotLimitSlippageBps,
    needsRebalance: effectivePerpRebalance,
    fundingRate: market.fundingRate,
    fundingEligible,
    minFundingRate,
    fundingScale,
    perpDecimals,
    spotDecimals,
    action: needsRebalance ? "order" : "noop",
  });
}

function extractSpotSize(state: unknown, baseSymbol: string): number {
  const root = state as any;
  const balances =
    (root?.balances as unknown) ??
    (root?.data?.balances as unknown) ??
    (root?.data as any)?.spot?.balances;

  if (Array.isArray(balances)) {
    const entry = balances.find((b: any) => {
      const coin = (b?.coin ?? b?.symbol ?? b?.asset ?? b?.token)?.toString();
      return typeof coin === "string"
        ? coin.toUpperCase() === baseSymbol.toUpperCase()
        : false;
    });
    const quantity =
      entry?.total ??
      entry?.balance ??
      entry?.amount ??
      entry?.available ??
      entry?.position?.total ??
      0;
    const parsed = Number.parseFloat(String(quantity));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function extractPerpSize(state: unknown, baseSymbol: string): number {
  const root = state as any;
  const positions =
    (root?.assetPositions as unknown) ??
    (root?.data?.assetPositions as unknown) ??
    (root?.data as any)?.positions;

  if (Array.isArray(positions)) {
    const entry = positions.find((p: any) => {
      const coin =
        typeof p?.coin === "string"
          ? p.coin
          : typeof p?.position?.coin === "string"
          ? p.position.coin
          : undefined;
      return typeof coin === "string"
        ? coin.toUpperCase().startsWith(baseSymbol.toUpperCase())
        : false;
    });
    const rawSize =
      entry?.szi ??
      entry?.position?.szi ??
      entry?.size ??
      entry?.position?.size ??
      0;
    const parsed = Number.parseFloat(String(rawSize));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function computeLimitPrice(markPrice: number, adjustment: number, slippageBps: number): string {
  const slip = Math.max(slippageBps, 0) / 10000;
  const price =
    adjustment > 0
      ? markPrice * (1 + slip) // buying perp -> pay up to mark plus slip
      : markPrice * (1 - slip); // selling perp -> accept down to mark minus slip
  return price.toString();
}

function normalizeSize(size: number, decimals: number | null): number {
  if (decimals === null) return size;
  const factor = 10 ** decimals;
  return Math.round(size * factor) / factor;
}

async function fetchMarketStats(
  symbol: string
): Promise<{ markPrice: number | null; fundingRate: number | null }> {
  const gatewayBase = process.env.OPENPOND_GATEWAY_URL?.replace(/\/$/, "");
  if (!gatewayBase)
    return { markPrice: null, fundingRate: null };

  const coin = symbol.split("-")[0] || symbol;
  const res = await fetch(
    `${gatewayBase}/v1/hyperliquid/market-stats?symbol=${encodeURIComponent(
      coin
    )}`
  );
  if (!res.ok) return { markPrice: null, fundingRate: null };
  const json = (await res.json().catch(() => null)) as {
    markPrice?: number;
    fundingRate?: number;
  } | null;
  const markPrice =
    typeof json?.markPrice === "number" && Number.isFinite(json.markPrice)
      ? json.markPrice
      : null;
  const fundingRate =
    typeof json?.fundingRate === "number" && Number.isFinite(json.fundingRate)
      ? json.fundingRate
      : null;
  return {
    markPrice: markPrice && markPrice > 0 ? markPrice : null,
    fundingRate,
  };
}

const decimalsCache = new Map<string, number>();

async function fetchSizeDecimals(
  symbol: string,
  environment: HyperliquidEnvironment,
  venue: "perp" | "spot"
): Promise<number | null> {
  const key = `${environment}:${venue}:${symbol}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  const baseUrl =
    environment === "mainnet"
      ? "https://api.hyperliquid.xyz"
      : "https://api.hyperliquid-testnet.xyz";

  if (venue === "perp") {
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    const json = (await res.json().catch(() => null)) as {
      universe?: Array<{ name: string; szDecimals?: number }>;
    } | null;
    const entry = json?.universe?.find(
      (u) => u.name.toUpperCase() === (symbol.split("-")[0] || symbol).toUpperCase()
    );
    const decimals =
      typeof entry?.szDecimals === "number" && Number.isFinite(entry.szDecimals)
        ? entry.szDecimals
        : null;
    if (decimals !== null) decimalsCache.set(key, decimals);
    return decimals;
  }

  const res = await fetch(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const json = (await res.json().catch(() => null)) as {
    universe?: Array<{ tokens: [number, number]; name: string; index: number }>;
    tokens?: Array<{ name: string; szDecimals: number }>;
  } | null;

  const [baseCandidate] = (symbol ?? "").split(/[-/]/);
  const target = baseCandidate?.toUpperCase();

  let decimals: number | null = null;
  if (json?.universe && json.tokens) {
    for (const entry of json.universe) {
      const [baseIdx] = entry.tokens;
      const baseToken = json.tokens[baseIdx];
      if (baseToken?.name?.toUpperCase() === target) {
        const sz = baseToken.szDecimals;
        if (typeof sz === "number" && Number.isFinite(sz)) {
          decimals = sz;
          break;
        }
      }
    }
  }
  if (decimals !== null) decimalsCache.set(key, decimals);
  return decimals;
}
