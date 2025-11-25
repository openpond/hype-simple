import { z } from "zod";
import { store } from "opentool/store";
import { wallet } from "opentool/wallet";

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
    "Record a local acknowledgement of Hyperliquid API terms for the configured Turnkey wallet.",
};

export const schema = z.object({
  environment: z.enum(["mainnet", "testnet"]).default("testnet"),
  termsVersion: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { environment, termsVersion } = schema.parse(body);

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

  await store({
    source: "hyperliquid",
    ref: `${environment}-terms-${Date.now()}`,
    status: "accepted",
    walletAddress,
    action: "terms",
    metadata: {
      environment,
      termsVersion: termsVersion ?? null,
      note: "Hyperliquid does not expose a terms endpoint; this records local acknowledgement only.",
    },
  });

  return Response.json({
    ok: true,
    environment,
    walletAddress,
    termsAccepted: true,
    termsVersion: termsVersion ?? null,
    note: "Hyperliquid does not expose a terms endpoint; this records local acknowledgement only.",
  });
}
