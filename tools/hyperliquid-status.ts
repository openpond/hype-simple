import { z } from "zod";
import { store } from "opentool/store";
import { wallet } from "opentool/wallet";
import { fetchHyperliquidClearinghouseState } from "../src/utils";

function resolveChainConfig(environment: "mainnet" | "testnet") {
  // opentool/wallet supports base + base-sepolia; we use those to obtain the signer,
  // then reuse the account for Arbitrum interactions inside utils.
  return environment === "mainnet"
    ? { chain: "base" }
    : { chain: "base-sepolia" };
}

export const profile = {
  description:
    "Check Hyperliquid clearinghouse state for the configured Turnkey wallet (confirms user existence).",
};

export const schema = z.object({
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
});

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { environment } = schema.parse(body);

  const chainConfig = resolveChainConfig(environment);
  const context = await wallet({
    chain: chainConfig.chain,
    rpcUrl: chainConfig.rpcUrl,
    turnkey: {
      organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
      signWith: process.env.TURNKEY_WALLET_ADDRESS as `0x${string}`,
    },
  });

  const walletAddress = context.address;
  const clearinghouse = await fetchHyperliquidClearinghouseState({
    environment,
    walletAddress,
  });

  await store({
    source: "hyperliquid",
    ref: `${environment}-status-${Date.now()}`,
    status: "checked",
    walletAddress,
    action: "status",
    metadata: {
      environment,
      clearinghouse,
    },
  });

  return Response.json({
    ok: true,
    environment,
    walletAddress,
    clearinghouse,
  });
}
