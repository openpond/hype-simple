import { z } from "zod";
import { wallet, WalletFullContext } from "opentool/wallet";
import { store } from "opentool/store";
import { transferHyperliquidSubAccount } from "opentool/adapters/hyperliquid";

function resolveChainConfig(environment: "mainnet" | "testnet") {
  return environment === "mainnet"
    ? { chain: "arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL }
    : { chain: "arbitrum-sepolia", rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL };
}

export const profile = {
  description:
    "Transfer USD between Hyperliquid main account and a subaccount (isDeposit=true moves into subaccount).",
};

export const schema = z.object({
  subAccountUser: z.string().min(1, "subAccountUser is required"),
  isDeposit: z.boolean().default(true),
  usd: z.union([z.string(), z.number()]).transform((v) => v.toString()),
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
});

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { subAccountUser, isDeposit, usd, environment } = schema.parse(body);

  const chain = resolveChainConfig(environment);
  const ctx = await wallet({ chain: chain.chain });

  const result = await transferHyperliquidSubAccount({
    wallet: ctx as WalletFullContext,
    environment,
    subAccountUser: subAccountUser as `0x${string}`,
    isDeposit,
    usd,
  });

  await store({
    source: "hyperliquid",
    ref: `subacct-transfer-${Date.now()}`,
    status: "submitted",
    walletAddress: ctx.address,
    action: "subaccount-transfer",
    notional: usd,
    network: `hyperliquid-${environment}`,
    metadata: {
      subAccountUser,
      isDeposit,
      usd,
      environment,
      response: result,
    },
  });

  return Response.json({
    ok: true,
    environment,
    subAccountUser,
    isDeposit,
    usd,
    response: result,
  });
}
