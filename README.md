# Perpetual Funding Rates API

[![MCP Server](https://img.shields.io/badge/MCP-server-blue)](https://funding-rates.api.klymax402.com/mcp)
[![x402](https://img.shields.io/badge/payments-x402-6E56CF)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Perpetual funding rates across Binance, Bybit and OKX. Scan every USDT perp ranked by funding in a single call, or query one asset with open interest and predicted next rate. Pay-per-call via [x402](https://x402.org) (USDC on Base L2) -- no API key, no signup, no rate-limit wall.

Part of the [klymax402](https://klymax402.com) marketplace -- 100 x402 micropayment APIs for AI agents, one wallet, USDC on Base.

## Quickstart -- MCP

Add to your MCP client config (Claude Desktop, Cursor, ElizaOS, etc.):

```json
{
  "mcpServers": {
    "funding-rates": {
      "url": "https://funding-rates.api.klymax402.com/mcp"
    }
  }
}
```

## Quickstart -- HTTP (x402)

```bash
# Whole market, biggest funding first
curl -X POST "https://funding-rates.api.klymax402.com/api/rates"   -H "Content-Type: application/json" -d '{"sort":"abs","limit":20,"minVenues":2}'
# -> 402 Payment Required, with an x402 payment challenge in the response body
```

Any x402-aware client ([`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch), [`x402-agent-tools`](https://www.npmjs.com/package/x402-agent-tools), ATXP) handles the 402 -> sign -> retry cycle automatically.

## Tools

| Tool | Method | Path | Price | Description |
|---|---|---|---|---|
| `perp_get_funding_rates` | GET | `/api/rates` | $0.001 | Scan funding rates across all perp markets, or query a single asset |
| `perp_get_funding_rates` | POST | `/api/rates` | $0.001 | Scan funding rates across all perp markets, or query a single asset (POST variant) |

### `perp_get_funding_rates`

Two modes on the same route, at the same price.

**Market scan** -- omit `symbol` and every USDT perp on Binance and Bybit comes back ranked by funding, so an agent finds an opportunity in one paid call instead of probing symbol by symbol.

**Single symbol** -- pass `symbol` and Binance, Bybit and OKX come back side by side for that asset, with open interest, mark price, next funding time and a sentiment read.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | no | Token symbol (e.g. BTC, ETH, SOL). Omit to scan the whole market. |
| `sort` | string | no | Scan only: `abs` (default), `highest`, `lowest`, `spread`. |
| `limit` | number | no | Scan only: markets to return. Default 50, max 1000. |
| `minVenues` | number | no | Scan only: set to 2 to keep only markets listed on both venues. |

**Returns (scan)**

- `markets` -- ranked list, each with `symbol`, per-venue `fundingRate` and `annualizedRate`
- `avgRate` / `annualizedRate` -- mean funding across venues, annualized as `rate * 3 * 365`
- `direction` -- `short opportunity` when funding is positive, `long opportunity` when negative
- `spread` / `spreadAnnualized` -- gap between the cheapest and dearest venue
- `longVenue` / `shortVenue` -- where to take each leg of the cross-venue carry

**Returns (single symbol)**

- `rates` -- array per exchange with funding rate, annualized rate, next funding time
- `summary` -- average, min, max, spread, sentiment, total open interest, mark price

Example response (scan):

```json
{"scan":true,"totalMarkets":600,"venues":["Binance","Bybit"],"sort":"abs","markets":[{"symbol":"PEPE","venueCount":2,"venues":{"Binance":{"fundingRate":0.0005,"annualizedRate":54.75},"Bybit":{"fundingRate":0.0003,"annualizedRate":32.85}},"avgRate":0.0004,"annualizedRate":43.8,"direction":"short opportunity (longs pay shorts)","spread":0.0002,"spreadAnnualized":21.9,"longVenue":"Bybit","shortVenue":"Binance"}]}
```

**When to use**: finding carry and basis trades, timing perp entries, monitoring funding costs on open positions.

**Not for**: spot prices (use `dex_get_swap_quote`), yields (use `defi_find_best_yields`), Hyperliquid-specific rates (use `hyperliquid_get_funding_rates`).

**Note**: market scans cover Binance and Bybit. OKX has no bulk funding-rate endpoint, so it is included only when you query a single symbol.

## Example agent prompts

- "Which perps have the most extreme funding right now?"
- "Find the biggest cross-venue funding spread I can carry"
- "What is the funding rate for ETH across Binance, Bybit and OKX?"

## Payment

- Protocol: [x402](https://x402.org) -- HTTP-native pay-per-call, no signup, no API key
- Network: Base L2 (`eip155:8453`)
- Asset: USDC
- Facilitator: Coinbase CDP (primary), PayAI (fallback)
- Also reachable via [ATXP](https://atxp.ai) (OAuth-wrapped x402, RFC 9728 protected-resource metadata)

## Part of klymax402

100 x402 micropayment APIs for AI agents -- one wallet, USDC on Base, zero signup.

- Catalog: https://klymax402.com/llms.txt
- Full API reference: https://klymax402.com/llms-full.txt
- Live stats: https://klymax402.com/stats

## License

MIT
