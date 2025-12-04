import { z } from "zod";
import { wallet } from "opentool/wallet";
import {
  placeHyperliquidOrder,
  updateHyperliquidLeverage,
} from "opentool/adapters/hyperliquid";
import { store } from "opentool/store";
import type { WalletFullContext } from "opentool/wallet";
import type {
  HyperliquidOrderResponse,
  HyperliquidOrderStatus,
  HyperliquidTriggerOptions,
} from "opentool/adapters/hyperliquid";

export const schema = z.object({
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  price: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v.toString())),
  size: z.union([z.string(), z.number()]).transform((v) => v.toString()),
  leverage: z.number().positive().max(100).optional(),
  leverageMode: z.enum(["cross", "isolated"]).default("cross"),
  takeProfitPx: z.union([z.string(), z.number()]).optional(),
  stopLossPx: z.union([z.string(), z.number()]).optional(),
  reduceOnly: z.boolean().default(false),
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
});

export const profile = {
  description:
    "Place a Hyperliquid entry (market or limit) with optional leverage, TP, SL, and reduce-only flag. TP/SL placed as separate reduce-only trigger orders.",
};

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ ok: false, error: parsed.error.flatten() }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    );
  }
  const {
    symbol,
    side,
    type,
    price,
    size,
    leverage,
    leverageMode,
    takeProfitPx,
    stopLossPx,
    reduceOnly,
    environment,
  } = parsed.data;

  const ctx = await wallet({
    chain: environment === "mainnet" ? "arbitrum" : "arbitrum-sepolia",
  });

  if (leverage !== undefined) {
    await updateHyperliquidLeverage({
      wallet: ctx as WalletFullContext,
      environment,
      input: {
        symbol,
        leverageMode,
        leverage,
      },
    });
  }

  const tif = type === "market" ? "FrontendMarket" : "Ioc";

  const extractOrderRef = (
    result: HyperliquidOrderResponse | unknown
  ): string | null => {
    const statuses = (result as any)?.response?.data?.statuses as
      | HyperliquidOrderStatus[]
      | undefined;
    if (!Array.isArray(statuses)) return null;
    for (const status of statuses) {
      const resting = (status as any).resting;
      if (resting?.cloid != null) return String(resting.cloid);
      if (resting?.oid != null) return String(resting.oid);
      const filled = (status as any).filled;
      if (filled?.cloid != null) return String(filled.cloid);
      if (filled?.oid != null) return String(filled.oid);
    }
    return null;
  };

  // Resolve price for market orders using gateway mark price.
  let entryPrice = price;
  if (type === "market") {
    const gatewayBase = process.env.OPENPOND_GATEWAY_URL?.replace(/\/$/, "");
    if (!gatewayBase) {
      throw new Error(
        "OPENPOND_GATEWAY_URL is not configured for price lookup."
      );
    }
    const coin = symbol.split("-")[0] || symbol;
    const url = `${gatewayBase}/v1/hyperliquid/market-stats?symbol=${encodeURIComponent(
      coin
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch market price (${res.status}) from gateway`
      );
    }
    const stats = (await res.json().catch(() => null)) as {
      markPrice?: number | null;
    } | null;
    const mark =
      typeof stats?.markPrice === "number" && Number.isFinite(stats.markPrice)
        ? stats.markPrice
        : null;
    if (mark == null || mark <= 0) {
      throw new Error("Gateway did not return a valid mark price.");
    }
    entryPrice = mark.toString();
  }

  if (!entryPrice && type === "limit") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "price is required for limit orders",
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    );
  }

  const entry = await placeHyperliquidOrder({
    wallet: ctx as WalletFullContext,
    environment,
    orders: [
      {
        symbol,
        side,
        price: entryPrice ?? "0",
        size,
        tif,
        reduceOnly,
      },
    ],
  });

  // Optional TP/SL as separate trigger reduce-only orders.
  const triggers: Array<
    Parameters<typeof placeHyperliquidOrder>[0]["orders"][number]
  > = [];
  if (takeProfitPx !== undefined) {
    const trigger: HyperliquidTriggerOptions = {
      triggerPx: takeProfitPx,
      isMarket: true,
      tpsl: "tp",
    };
    triggers.push({
      symbol,
      side: side === "buy" ? "sell" : "buy",
      price: takeProfitPx,
      size,
      tif: "Ioc",
      reduceOnly: true,
      trigger,
    });
  }
  if (stopLossPx !== undefined) {
    const trigger: HyperliquidTriggerOptions = {
      triggerPx: stopLossPx,
      isMarket: true,
      tpsl: "sl",
    };
    triggers.push({
      symbol,
      side: side === "buy" ? "sell" : "buy",
      price: stopLossPx,
      size,
      tif: "Ioc",
      reduceOnly: true,
      trigger,
    });
  }

  let tpSlResult: unknown = null;
  if (triggers.length) {
    tpSlResult = await placeHyperliquidOrder({
      wallet: ctx as WalletFullContext,
      environment,
      orders: triggers,
    });
  }

  const orderRef = extractOrderRef(entry) ?? `${symbol}-${Date.now()}`;

  // Persist entry + optional TP/SL setup
  await store({
    source: "hyperliquid",
    ref: orderRef,
    status: "submitted",
    walletAddress: ctx.address,
    action: "order",
    notional: size,
    network: "hyperliquid",
    metadata: {
      symbol,
      side,
      type,
      price: entryPrice ?? null,
      size,
      leverage: leverage ?? null,
      leverageMode,
      reduceOnly,
      takeProfitPx: takeProfitPx ?? null,
      stopLossPx: stopLossPx ?? null,
      environment,
      entryResponse: entry,
      tpSlResponse: tpSlResult,
    },
  });

  return Response.json({
    ok: true,
    environment,
    entry,
    tpSl: tpSlResult,
  });
}
