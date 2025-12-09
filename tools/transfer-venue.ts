import { z } from "zod";
import { wallet, WalletFullContext } from "opentool/wallet";
import { store } from "opentool/store";
import {
  sendHyperliquidAsset,
  transferHyperliquidUsdClass,
} from "opentool/adapters/hyperliquid";

function resolveChainConfig(environment: "mainnet" | "testnet") {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : { chain: "arbitrum-sepolia", rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL };
}

export const profile = {
  description:
    "Transfer between Hyperliquid perp/spot venues. Use type=usdClass for collateral, or type=asset for arbitrary token.",
};

export const schema = z.object({
  type: z.enum(["usdClass", "asset"]).default("usdClass"),
  toPerp: z.boolean().default(true), // for usdClass transfers
  amount: z.union([z.string(), z.number()]).transform((v) => v.toString()),
  sourceDex: z.string().default(""), // "" for perp, "spot" for spot when type=asset
  destinationDex: z.string().default("spot"),
  token: z.string().default("USDC"),
  fromSubAccount: z.string().optional(),
  destination: z.string().optional(), // optional for asset send; defaults to own address
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
});

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.parse(body);
  const {
    type,
    toPerp,
    amount,
    sourceDex,
    destinationDex,
    token,
    fromSubAccount,
    destination,
    environment,
  } = parsed;

  const chain = resolveChainConfig(environment);
  const ctx = await wallet({ chain: chain.chain });

  let response: unknown = null;

  if (type === "usdClass") {
    response = await transferHyperliquidUsdClass({
      wallet: ctx as WalletFullContext,
      environment,
      amount,
      toPerp,
    });
  } else {
    const dest = (destination ?? ctx.address) as `0x${string}`;
    response = await sendHyperliquidAsset({
      wallet: ctx as WalletFullContext,
      environment,
      destination: dest,
      sourceDex,
      destinationDex,
      token,
      amount,
      fromSubAccount: fromSubAccount as `0x${string}` | undefined,
    });
  }

  await store({
    source: "hyperliquid",
    ref: `venue-transfer-${Date.now()}`,
    status: "submitted",
    walletAddress: ctx.address,
    action: "venue-transfer",
    notional: amount,
    network: `hyperliquid-${environment}`,
    metadata: {
      type,
      toPerp,
      amount,
      sourceDex,
      destinationDex,
      token,
      fromSubAccount: fromSubAccount ?? null,
      destination: destination ?? ctx.address,
      environment,
      response,
    },
  });

  return Response.json({
    ok: true,
    environment,
    type,
    toPerp,
    amount,
    sourceDex,
    destinationDex,
    token,
    fromSubAccount: fromSubAccount ?? null,
    destination: destination ?? ctx.address,
    response,
  });
}
