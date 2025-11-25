# Hyperliquid Utility OpenTool

Utility OpenTool project for Hyperliquid: create the HL user (via deposit/bridge), check clearinghouse status, record local terms acknowledgment, and withdraw funds. Uses `opentool/wallet` for signing and `opentool/store` for persistence.

## Tools

- `tools/hyperliquid-status.ts` – Check clearinghouse state (confirms HL user exists).
- `tools/hyperliquid-accept-terms.ts` – Record local acknowledgment of HL API terms (HL has no terms API).
- `tools/hyperliquid-deposit.ts` – Bridge USDC to HL (creates user on first deposit).
- `tools/hyperliquid-withdraw.ts` – Withdraw USDC from HL via `withdraw3`.
- `tools/trade.ts` – Place Hyperliquid perp order (IOC by default).
- `metadata.ts` – Project metadata.
- `utils.ts` – Shared HL helpers (signing, deposit/withdraw, clearinghouse fetch).

## Env Vars (required)

- `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_WALLET_ADDRESS`
- RPC: `ARBITRUM_RPC_URL` (mainnet), `ARBITRUM_SEPOLIA_RPC_URL` (testnet)

Optional overrides: `HYPERLIQUID_BRIDGE_ADDRESS`, `HYPERLIQUID_USDC_ADDRESS`, `HYPERLIQUID_SIGNATURE_CHAIN_ID`.

## Quick Start

```bash
npm install
npm run dev
# dev server at http://localhost:7000
```

## Curl Examples (testnet)

- Status:
  ```bash
  curl -X POST http://localhost:7000/hyperliquid-status \
    -H "Content-Type: application/json" \
    -d '{"environment":"testnet"}'
  ```
- Accept terms (local record only):
  ```bash
  curl -X POST http://localhost:7000/hyperliquid-accept-terms \
    -H "Content-Type: application/json" \
    -d '{"environment":"testnet","termsVersion":"v1"}'
  ```
- Deposit (creates HL user on first deposit, min 5 USDC):
  ```bash
  curl -X POST http://localhost:7000/hyperliquid-deposit \
    -H "Content-Type: application/json" \
    -d '{"environment":"testnet","amount":"5.5"}'
  ```
- Withdraw:
  ```bash
  curl -X POST http://localhost:7000/hyperliquid-withdraw \
    -H "Content-Type: application/json" \
    -d '{"environment":"testnet","amount":"1","destination":"0x..."}'
  ```
- Place order:
  ```bash
  curl -X POST http://localhost:7000/trade \
    -H "Content-Type: application/json" \
    -d '{"symbol":"BTC","side":"buy","price":"10000","size":"0.01","tif":"Ioc"}'
  ```

For mainnet, set `"environment":"mainnet"` and ensure RPC/bridge funds are on Arbitrum One.
