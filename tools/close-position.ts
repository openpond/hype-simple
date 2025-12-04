import { z } from "zod";
import { wallet } from "opentool/wallet";
import {
  placeHyperliquidOrder,
  HyperliquidApiError,
  fetchHyperliquidClearinghouseState,
} from "opentool/adapters/hyperliquid";
import { store } from "opentool/store";
import type { WalletFullContext } from "opentool/wallet";

export const schema = z.object({
  symbol: z.string().min(1),
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
  size: z.union([z.string(), z.number()]).optional(),
});

export const profile = {
  description:
    "Close a Hyperliquid position (market reduce-only). If size is omitted, closes the full position.",
};

export async function POST(req: Request): Promise<Response> {
  try {
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

    const { symbol, environment } = parsed.data;
    const requestedSize = parsed.data.size;

    const ctx = await wallet({
      chain: environment === "mainnet" ? "arbitrum" : "arbitrum-sepolia",
    });

    const walletAddress = ctx.address;
    const currentSize =
      requestedSize !== undefined
        ? Number.parseFloat(String(requestedSize))
        : await (async () => {
            try {
              const state = await fetchHyperliquidClearinghouseState({
                environment,
                walletAddress: walletAddress as `0x${string}`,
              });
              const target = symbol.toUpperCase();
              const pos = (state.data as any)?.assetPositions?.find(
                (p: any) => p.coin?.toUpperCase() === target
              );
              const raw = pos?.szi ?? pos?.position?.szi;
              const numeric =
                typeof raw === "number"
                  ? raw
                  : typeof raw === "string" && raw.trim().length > 0
                    ? Number.parseFloat(raw)
                    : null;
              return Number.isFinite(numeric) ? numeric : null;
            } catch {
              return null;
            }
          })();

    if (!currentSize || !Number.isFinite(currentSize) || currentSize === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "No open position to close or size not provided.",
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        }
      );
    }

    const side = currentSize > 0 ? "sell" : "buy";
    const sizeAbs = Math.abs(currentSize).toString();

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
      network:
        environment === "mainnet" ? "hyperliquid" : "hyperliquid-testnet",
      metadata: {
        symbol,
        side,
        requestedSize: requestedSize ?? null,
        closedSize: sizeAbs,
        environment,
        entryResponse: entry,
      },
    });

    return Response.json({
      ok: true,
      environment,
      ref,
      entry,
    });
  } catch (error) {
    if (error instanceof HyperliquidApiError) {
      return Response.json(
        { ok: false, error: error.message, exchangeResponse: error.response },
        { status: 500 }
      );
    }
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
