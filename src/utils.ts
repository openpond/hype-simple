import { encode as encodeMsgpack } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseUnits,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { WalletFullContext } from "opentool/wallet";

const API_BASES = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const satisfies Record<HyperliquidEnvironment, string>;

const EXCHANGE_TYPED_DATA_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
};

const CACHE_TTL_MS = 5 * 60 * 1000;

const HL_ENDPOINT = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const satisfies Record<HyperliquidEnvironment, string>;

const HL_CHAIN_LABEL = {
  mainnet: "Mainnet",
  testnet: "Testnet",
} as const satisfies Record<HyperliquidEnvironment, string>;

const HL_BRIDGE_ADDRESSES: Record<HyperliquidEnvironment, `0x${string}`> = {
  mainnet: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
  testnet: "0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89",
};

const HL_USDC_ADDRESSES: Record<HyperliquidEnvironment, `0x${string}`> = {
  mainnet: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  testnet: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
};

const HL_SIGNATURE_CHAIN_ID = {
  mainnet: "0xa4b1",
  testnet: "0x66eee",
} as const satisfies Record<HyperliquidEnvironment, string>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const MIN_DEPOSIT_USDC = 5;

const metaCache = new Map<
  string,
  { fetchedAt: number; universe: MetaResponse["universe"] }
>();

export type HyperliquidEnvironment = "mainnet" | "testnet";
export type HyperliquidTimeInForce =
  | "Gtc"
  | "Ioc"
  | "Alo"
  | "FrontendMarket"
  | "LiquidationMarket";
export type HyperliquidGrouping = "na" | "normalTpsl" | "positionTpsl";
export type HyperliquidTriggerType = "tp" | "sl";

export interface HyperliquidTriggerOptions {
  triggerPx: string | number | bigint;
  isMarket?: boolean;
  tpsl: HyperliquidTriggerType;
}

export interface HyperliquidOrderIntent {
  symbol: string;
  side: "buy" | "sell";
  price: string | number | bigint;
  size: string | number | bigint;
  tif?: HyperliquidTimeInForce;
  reduceOnly?: boolean;
  clientId?: `0x${string}`;
  trigger?: HyperliquidTriggerOptions;
}

export interface HyperliquidBuilderFee {
  address: `0x${string}`;
  fee: number;
}

export interface HyperliquidOrderOptions {
  wallet: WalletFullContext;
  orders: HyperliquidOrderIntent[];
  grouping?: HyperliquidGrouping;
  builder?: HyperliquidBuilderFee;
  environment?: HyperliquidEnvironment;
  baseUrl?: string;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
  nonce?: number;
  fetcher?: typeof fetch;
}

export type HyperliquidOrderStatus =
  | { resting: { oid: number; cloid?: `0x${string}` } }
  | {
      filled: {
        totalSz: string;
        avgPx: string;
        oid: number;
        cloid?: `0x${string}`;
      };
    }
  | { error: string };

export interface HyperliquidOrderResponse {
  status: "ok";
  response: {
    type: "order";
    data: {
      statuses: HyperliquidOrderStatus[];
    };
  };
}

export class HyperliquidApiError extends Error {
  constructor(message: string, public readonly response: unknown) {
    super(message);
    this.name = "HyperliquidApiError";
  }
}

type MetaResponse = {
  universe: Array<{
    name: string;
  }>;
};

type ExchangeOrderAction = {
  type: "order";
  orders: Array<{
    a: number;
    b: boolean;
    p: string;
    s: string;
    r: boolean;
    t:
      | { limit: { tif: HyperliquidTimeInForce } }
      | {
          trigger: {
            isMarket: boolean;
            triggerPx: string;
            tpsl: HyperliquidTriggerType;
          };
        };
    c?: `0x${string}`;
  }>;
  grouping: HyperliquidGrouping;
  builder?: {
    b: `0x${string}`;
    f: number;
  };
};

type ExchangeSignature = {
  r: `0x${string}`;
  s: `0x${string}`;
  v: 27 | 28;
};

type ExchangeRequestBody = {
  action: ExchangeOrderAction;
  nonce: number;
  signature: ExchangeSignature;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
};

export interface HyperliquidDepositResult {
  txHash: `0x${string}`;
  amount: number;
  amountUnits: string;
  environment: HyperliquidEnvironment;
  bridgeAddress: `0x${string}`;
}

export interface HyperliquidWithdrawResult {
  amount: number;
  destination: `0x${string}`;
  environment: HyperliquidEnvironment;
  nonce: number;
  status: string;
}

export interface HyperliquidClearinghouseState {
  ok: boolean;
  data: Record<string, unknown> | null;
}

/**
 * Sign and submit one or more orders to the Hyperliquid exchange endpoint.
 * Assumes the provided wallet context exposes a viem-compatible signer
 * (as returned from `opentool/wallet`). Symbols refer to the perp universe
 * returned by Hyperliquid's `meta` info call (e.g. `BTC-USD`).
 */
export async function placeHyperliquidOrder(
  options: HyperliquidOrderOptions
): Promise<HyperliquidOrderResponse> {
  const {
    wallet,
    orders,
    grouping = "na",
    builder,
    environment,
    baseUrl,
    vaultAddress,
    expiresAfter,
    nonce,
    fetcher = fetch,
  } = options;

  if (!wallet?.account || !wallet.walletClient) {
    throw new Error(
      "Hyperliquid order signing requires a wallet with signing capabilities."
    );
  }

  if (!orders.length) {
    throw new Error("At least one order is required.");
  }

  const inferredEnvironment = environment ?? inferEnvironment(baseUrl);
  const resolvedBaseUrl = baseUrl ?? API_BASES[inferredEnvironment];

  const universe = await getUniverse({
    baseUrl: resolvedBaseUrl,
    environment: inferredEnvironment,
    fetcher,
  });

  const preparedOrders = orders.map((intent) => {
    const assetIndex = resolveAssetIndex(intent.symbol, universe);

    const limitOrTrigger = intent.trigger
      ? {
          trigger: {
            isMarket: Boolean(intent.trigger.isMarket),
            triggerPx: toApiDecimal(intent.trigger.triggerPx),
            tpsl: intent.trigger.tpsl,
          },
        }
      : {
          limit: {
            tif: intent.tif ?? "Ioc",
          },
        };

    const order: ExchangeOrderAction["orders"][number] = {
      a: assetIndex,
      b: intent.side === "buy",
      p: toApiDecimal(intent.price),
      s: toApiDecimal(intent.size),
      r: intent.reduceOnly ?? false,
      t: limitOrTrigger,
      ...(intent.clientId
        ? {
            c: normalizeHex(intent.clientId),
          }
        : {}),
    };

    return order;
  });

  const action: ExchangeOrderAction = {
    type: "order",
    orders: preparedOrders,
    grouping,
  };

  if (builder) {
    action.builder = {
      b: normalizeAddress(builder.address),
      f: builder.fee,
    };
  }

  const effectiveNonce = nonce ?? Date.now();
  const signature = await signL1Action({
    wallet,
    action,
    nonce: effectiveNonce,
    vaultAddress,
    expiresAfter,
    isTestnet: inferredEnvironment === "testnet",
  });

  const body: ExchangeRequestBody = {
    action,
    nonce: effectiveNonce,
    signature,
  };

  if (vaultAddress) {
    body.vaultAddress = normalizeAddress(vaultAddress);
  }

  if (typeof expiresAfter === "number") {
    body.expiresAfter = expiresAfter;
  }

  const response = await fetcher(`${resolvedBaseUrl}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await response
    .json()
    .catch(() => null)) as HyperliquidOrderResponse | null;

  if (!response.ok || !json) {
    throw new HyperliquidApiError(
      "Failed to submit Hyperliquid order.",
      json ?? { status: response.status }
    );
  }

  if (json.status !== "ok") {
    throw new HyperliquidApiError(
      "Hyperliquid API returned an error status.",
      json
    );
  }

  const statuses = json.response?.data?.statuses ?? [];
  const errorStatuses = statuses.filter(
    (entry): entry is { error: string } => "error" in entry
  );
  if (errorStatuses.length) {
    const message = errorStatuses.map((entry) => entry.error).join(", ");
    throw new HyperliquidApiError(
      message || "Hyperliquid rejected the order.",
      json
    );
  }

  return json;
}

function inferEnvironment(baseUrl?: string): HyperliquidEnvironment {
  if (baseUrl?.includes("testnet")) return "testnet";
  return "mainnet";
}

async function getUniverse(args: {
  baseUrl: string;
  environment: HyperliquidEnvironment;
  fetcher: typeof fetch;
}): Promise<MetaResponse["universe"]> {
  const cacheKey = `${args.environment}:${args.baseUrl}`;
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.universe;
  }

  const response = await args.fetcher(`${args.baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });

  const json = (await response.json().catch(() => null)) as MetaResponse | null;
  if (!response.ok || !json?.universe) {
    throw new HyperliquidApiError(
      "Unable to load Hyperliquid metadata.",
      json ?? { status: response.status }
    );
  }

  metaCache.set(cacheKey, { fetchedAt: Date.now(), universe: json.universe });
  return json.universe;
}

function resolveAssetIndex(
  symbol: string,
  universe: MetaResponse["universe"]
): number {
  const [raw] = symbol.split("-");
  const target = raw.trim();
  const index = universe.findIndex(
    (entry) => entry.name.toUpperCase() === target.toUpperCase()
  );
  if (index === -1) {
    throw new Error(`Unknown Hyperliquid asset symbol: ${symbol}`);
  }
  return index;
}

function toApiDecimal(value: string | number | bigint): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (!Number.isFinite(value)) {
    throw new Error("Numeric values must be finite.");
  }

  const asString = value.toString();
  if (/e/i.test(asString)) {
    const [mantissa, exponentPart] = asString.split(/e/i);
    const exponent = Number(exponentPart);
    const [integerPart, fractionalPart = ""] = mantissa.split(".");
    if (exponent >= 0) {
      return (
        integerPart +
        fractionalPart.padEnd(exponent + fractionalPart.length, "0")
      );
    }
    const zeros = "0".repeat(Math.abs(exponent) - 1);
    return `0.${zeros}${integerPart}${fractionalPart}`.replace(/\.0+$/, "");
  }

  return asString;
}

function normalizeHex(value: `0x${string}`): `0x${string}` {
  const lower = value.toLowerCase();
  return (lower.replace(/^0x0+/, "0x") || "0x0") as `0x${string}`;
}

function normalizeAddress(value: `0x${string}`): `0x${string}` {
  return normalizeHex(value);
}

async function signL1Action(args: {
  wallet: WalletFullContext;
  action: ExchangeOrderAction;
  nonce: number;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
  isTestnet: boolean;
}): Promise<ExchangeSignature> {
  const { wallet, action, nonce, vaultAddress, expiresAfter, isTestnet } = args;

  const actionHash = createL1ActionHash({
    action,
    nonce,
    vaultAddress,
    expiresAfter,
  });
  const message = {
    source: isTestnet ? "b" : "a",
    connectionId: actionHash,
  } as const;

  const signatureHex = await wallet.walletClient.signTypedData({
    account: wallet.account,
    domain: EXCHANGE_TYPED_DATA_DOMAIN,
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message,
  });

  return splitSignature(signatureHex);
}

function splitSignature(signature: `0x${string}`): ExchangeSignature {
  const cleaned = signature.slice(2);
  const rHex = `0x${cleaned.slice(0, 64)}` as `0x${string}`;
  const sHex = `0x${cleaned.slice(64, 128)}` as `0x${string}`;
  let v = parseInt(cleaned.slice(128, 130), 16);
  if (Number.isNaN(v)) {
    throw new Error("Invalid signature returned by wallet client.");
  }
  if (v < 27) {
    v += 27;
  }
  const normalizedV = (v === 27 || v === 28 ? v : v % 2 ? 27 : 28) as 27 | 28;
  return {
    r: normalizeHex(rHex),
    s: normalizeHex(sHex),
    v: normalizedV,
  };
}

function createL1ActionHash(args: {
  action: ExchangeOrderAction;
  nonce: number;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
}): `0x${string}` {
  const { action, nonce, vaultAddress, expiresAfter } = args;

  const actionBytes = encodeMsgpack(action, { ignoreUndefined: true });
  const nonceBytes = toUint64Bytes(nonce);

  const vaultMarker = vaultAddress ? new Uint8Array([1]) : new Uint8Array([0]);
  const vaultBytes = vaultAddress
    ? hexToBytes(vaultAddress.slice(2))
    : new Uint8Array();

  const hasExpiresAfter = typeof expiresAfter === "number";
  const expiresMarker = hasExpiresAfter
    ? new Uint8Array([0])
    : new Uint8Array();
  const expiresBytes =
    hasExpiresAfter && expiresAfter !== undefined
      ? toUint64Bytes(expiresAfter)
      : new Uint8Array();

  const bytes = concatBytes(
    actionBytes,
    nonceBytes,
    vaultMarker,
    vaultBytes,
    expiresMarker,
    expiresBytes
  );
  const hash = keccak_256(bytes);
  return `0x${bytesToHex(hash)}`;
}

function toUint64Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function resolveRpcUrl(env: HyperliquidEnvironment) {
  if (env === "mainnet") {
    return process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
  }
  return (
    process.env.ARBITRUM_SEPOLIA_RPC_URL ??
    "https://sepolia-rollup.arbitrum.io/rpc"
  );
}

function getBridgeAddress(env: HyperliquidEnvironment): `0x${string}` {
  const override = process.env.HYPERLIQUID_BRIDGE_ADDRESS;
  if (override?.trim()) {
    return normalizeAddress(override as `0x${string}`);
  }
  return HL_BRIDGE_ADDRESSES[env];
}

function getUsdcAddress(env: HyperliquidEnvironment): `0x${string}` {
  const override = process.env.HYPERLIQUID_USDC_ADDRESS;
  if (override?.trim()) {
    return normalizeAddress(override as `0x${string}`);
  }
  return HL_USDC_ADDRESSES[env];
}

function getSignatureChainId(env: HyperliquidEnvironment): string {
  const override = process.env.HYPERLIQUID_SIGNATURE_CHAIN_ID;
  const selected = override?.trim() || HL_SIGNATURE_CHAIN_ID[env];
  return normalizeHex(selected as `0x${string}`);
}

export async function depositToHyperliquidBridge(options: {
  environment: HyperliquidEnvironment;
  amount: string;
  wallet: WalletFullContext;
}): Promise<HyperliquidDepositResult> {
  const { environment, amount, wallet } = options;
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Deposit amount must be a positive number.");
  }
  if (parsedAmount < MIN_DEPOSIT_USDC) {
    throw new Error(`Minimum deposit is ${MIN_DEPOSIT_USDC} USDC.`);
  }

  if (!wallet.account || !wallet.walletClient) {
    throw new Error("Wallet with signing capability is required for deposit.");
  }

  const rpcUrl = resolveRpcUrl(environment);
  const chain = environment === "mainnet" ? arbitrum : arbitrumSepolia;

  const bridgeAddress = getBridgeAddress(environment);
  const usdcAddress = getUsdcAddress(environment);
  const amountUnits = parseUnits(amount, 6);

  const walletClient =
    wallet.walletClient ??
    createWalletClient({
      account: wallet.account,
      chain,
      transport: http(rpcUrl),
    });

  const transport = walletClient.transport ?? http(rpcUrl);
  const publicClient = createPublicClient({
    chain: walletClient.chain ?? chain,
    transport,
  });

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [bridgeAddress, amountUnits],
  });

  const txHash = await walletClient.sendTransaction({
    account: wallet.account,
    to: usdcAddress,
    data,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    amount: parsedAmount,
    amountUnits: amountUnits.toString(),
    environment,
    bridgeAddress,
  };
}

export async function withdrawFromHyperliquid(options: {
  environment: HyperliquidEnvironment;
  amount: string;
  destination: `0x${string}`;
  wallet: WalletFullContext;
}): Promise<HyperliquidWithdrawResult> {
  const { environment, amount, destination, wallet } = options;
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Withdraw amount must be a positive number.");
  }

  if (!wallet.account || !wallet.walletClient) {
    throw new Error("Wallet with signing capability is required for withdraw.");
  }

  const signatureChainId = getSignatureChainId(environment);
  const hyperliquidChain = HL_CHAIN_LABEL[environment];

  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: Number.parseInt(signatureChainId, 16),
    verifyingContract: ZERO_ADDRESS,
  } as const;

  const time = BigInt(Date.now());
  const nonce = Number(time);
  const normalizedDestination = normalizeAddress(destination);

  const message = {
    hyperliquidChain,
    destination: normalizedDestination,
    amount: parsedAmount.toString(),
    time,
  };

  const types = {
    "HyperliquidTransaction:Withdraw": [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  } as const;

  const signatureHex = await wallet.walletClient.signTypedData({
    account: wallet.account,
    domain,
    types,
    primaryType: "HyperliquidTransaction:Withdraw",
    message,
  });

  const signature = splitSignature(signatureHex);

  const payload = {
    action: {
      type: "withdraw3",
      signatureChainId,
      hyperliquidChain,
      destination: normalizedDestination,
      amount: parsedAmount.toString(),
      time: nonce,
    },
    nonce,
    signature,
  };

  const endpoint = `${HL_ENDPOINT[environment]}/exchange`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = (await response.json().catch(() => null)) as {
    status?: string;
    response?: unknown;
    error?: string;
  } | null;

  if (!response.ok || json?.status !== "ok") {
    throw new Error(
      `Hyperliquid withdraw failed: ${
        json?.response ?? json?.error ?? response.statusText
      }`
    );
  }

  return {
    amount: parsedAmount,
    destination: normalizedDestination,
    environment,
    nonce,
    status: json.status ?? "ok",
  };
}

export async function fetchHyperliquidClearinghouseState(params: {
  environment: HyperliquidEnvironment;
  walletAddress: `0x${string}`;
}): Promise<HyperliquidClearinghouseState> {
  const { environment, walletAddress } = params;
  const response = await fetch(`${HL_ENDPOINT[environment]}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: walletAddress }),
  });

  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  return {
    ok: response.ok,
    data,
  };
}
