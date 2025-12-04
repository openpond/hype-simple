import { z } from "zod";
import { HyperliquidApiError, placeHyperliquidOrder } from "opentool/adapters/hyperliquid";
import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import type { WalletFullContext } from "opentool/wallet";

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveChainConfig(environment: "mainnet" | "testnet") {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : { chain: "arbitrum-sepolia", rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL };
}

export const schema = z.object({
  symbol: z.string().min(1),
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
  size: z.union([z.string(), z.number()]).refine(
    (v) => {
      const n = toFiniteNumber(v);
      return n !== null && n !== 0;
    },
    { message: "size must be a non-zero number" }
  ),
});

export const profile = {
  description: "Close a Hyperliquid position (market reduce-only) for the given size.",
};

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ ok: false, error: parsed.error.flatten() }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const { symbol, environment } = parsed.data;
    const requestedSize = parsed.data.size;

    const chainConfig = resolveChainConfig(environment);
    const ctx = await wallet({ chain: chainConfig.chain, rpcUrl: chainConfig.rpcUrl });

    const walletAddress = ctx.address;
    const numericSize = toFiniteNumber(requestedSize);
    if (numericSize === null || numericSize === 0) {
      return new Response(JSON.stringify({ ok: false, error: "size must be a non-zero number" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const side = numericSize > 0 ? "sell" : "buy";
    const sizeAbs = Math.abs(numericSize).toString();

    const entry = await placeHyperliquidOrder({
      wallet: ctx as WalletFullContext,
      environment,
      orders: [
        {
          symbol,
          side,
          price: "0",
          size: sizeAbs,
          tif: "FrontendMarket",
          reduceOnly: true,
        },
      ],
    });

    const ref = `close-${symbol}-${Date.now()}`;

    await store({
      source: "hyperliquid",
      ref,
      status: "submitted",
      walletAddress,
      action: "close",
      notional: sizeAbs,
      network: environment === "mainnet" ? "hyperliquid" : "hyperliquid-testnet",
      metadata: {
        symbol,
        side,
        requestedSize: requestedSize ?? null,
        closedSize: sizeAbs,
        environment,
        entryResponse: entry,
      },
    });

    return Response.json({ ok: true, environment, ref, entry });
  } catch (error) {
    if (error instanceof HyperliquidApiError) {
      return Response.json(
        { ok: false, error: error.message, exchangeResponse: error.response },
        { status: 500 }
      );
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
