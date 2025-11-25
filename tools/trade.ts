import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import { z } from "zod";
import { placeHyperliquidOrder } from "../src/utils";

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
    "Place a Hyperliquid perp order (symbol, side, price, size, tif) using the Base Sepolia signer.",
};

const decimalString = z
  .string()
  .min(1, "value is required")
  .refine((v) => /^\d+(?:\.\d+)?$/.test(v), "must be a decimal string");

export const schema = z.object({
  symbol: z.string().min(1, "symbol is required"),
  side: z.enum(["buy", "sell"]),
  price: decimalString,
  size: decimalString,
  tif: z
    .enum(["Gtc", "Ioc", "Alo", "FrontendMarket", "LiquidationMarket"])
    .default("Gtc"),
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
});

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { symbol, side, price, size, tif, environment } = schema.parse(body);

  const chainConfig = resolveChainConfig(environment);
  const context = await wallet({
    chain: chainConfig.chain,
    apiKey: process.env.ALCHEMY_API_KEY,
    rpcUrl: process.env.RPC_URL,
    turnkey: {
      organizationId: process.env.TURNKEY_SUBORG_ID!,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
      signWith: process.env.TURNKEY_WALLET_ADDRESS!,
      apiBaseUrl: process.env.TURNKEY_API_BASE_URL,
    },
  });

  const orderResponse = await placeHyperliquidOrder({
    wallet: context,
    environment: "testnet",
    orders: [
      {
        symbol,
        side,
        price,
        size,
        tif,
      },
    ],
  });

  const statuses = orderResponse.response?.data?.statuses ?? [];
  const firstStatus = statuses[0];
  if (!firstStatus) {
    throw new Error("Hyperliquid did not return an order status.");
  }

  const orderId =
    "resting" in firstStatus
      ? firstStatus.resting.oid
      : "filled" in firstStatus
      ? firstStatus.filled.oid
      : null;

  if (!orderId) {
    throw new Error("Unable to determine Hyperliquid order id.");
  }

  await store({
    source: "hyperliquid",
    ref: orderId.toString(),
    status: "submitted",
    walletAddress: context.address,
    action: "order",
    notional: size,
    metadata: {
      orderId,
      symbol,
      side,
      tif,
      amount: size,
      buyPrice: price,
    },
  });

  return Response.json({
    ok: true,
  });
}
