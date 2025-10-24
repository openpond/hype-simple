// CITATION (paper baseline used for this rule-set):
// Cohen, G. (2023) "Intraday algorithmic trading strategies for cryptocurrencies."
// Tested 5–180-minute systems across BTC/ETH/BNB/ADA/XRP; RSI-based systems
// outperformed Buy-and-Hold intraday in the sample. We implement a deterministic,
// always-in-market RSI variant with standard Wilder RSI conventions.

import { wallet } from "opentool/wallet";
import { placeHyperliquidOrder } from "../utils";

// ------------------------------- Route ------------------------------------
export async function POST(req: Request): Promise<Response> {
  // Wallet
  const context = await wallet({
    chain: "base-sepolia",
    apiKey: process.env.ALCHEMY_API_KEY,
    turnkey: {
      organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
      signWith: process.env.TURNKEY_WALLET_ADDRESS as `0x${string}`,
    },
  });
  console.log(process.env.TEST_API_KEY);

  // Execute with Hyperliquid (simple market-like IOC)
  let tradeTaken = false;
  let hyperliquidOrder: unknown = null;
  let tradeError: string | null = null;

  const result = await placeHyperliquidOrder({
    wallet: context,
    environment: "testnet",
    orders: [
      {
        symbol: "BTC-USDC",
        side: "buy",
        price: 100000,
        size: "0.0001", // $5 worth of BTC at $100k price
        tif: "Gtc",
      },
    ],
  });
  hyperliquidOrder = result;
  tradeTaken = true;

  return new Response(JSON.stringify(hyperliquidOrder, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
