# Perpetual Funding Rates API

[![MCP Server](https://img.shields.io/badge/MCP-server-blue)](https://funding-rates.api.klymax402.com/mcp)
[![x402](https://img.shields.io/badge/payments-x402-6E56CF)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Live perpetual funding rates across Binance, Bybit, OKX -- open interest and predicted next rate included. Pay-per-call via [x402](https://x402.org) (USDC on Base L2) -- no API key, no signup, no rate-limit wall.

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
curl "https://funding-rates.api.klymax402.com/api/rates?symbol=BTC"
# -> 402 Payment Required, with an x402 payment challenge in the response body
```

Any x402-aware client ([`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch), [`x402-agent-tools`](https://www.npmjs.com/package/x402-agent-tools), ATXP) handles the 402 -> sign -> retry cycle automatically.

## Tools

| Tool | Method | Path | Price | Description |
|---|---|---|---|---|
| `perp_get_funding_rates` | GET | `/api/rates` | $0.002 | Get perpetual futures funding rates across exchanges |

### `perp_get_funding_rates`

Use this when you need current perpetual futures funding rates for a single asset across exchanges. Returns rates comparison in JSON.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | yes | Token symbol (e.g. BTC, ETH, SOL) |

**Returns**

- `symbol` -- trading pair symbol
- `rates` -- array per exchange with exchange name, current funding rate, annualized rate
- `openInterest` -- open interest in USD per exchange
- `predictedNextRate` -- predicted next funding rate per exchange
- `nextFundingTime` -- timestamp of next funding event

Example response:

```json
{"symbol":"ETH","rates":[{"exchange":"Binance","rate":0.0082,"annualized":8.98},{"exchange":"Bybit","rate":0.0075,"annualized":8.21},{"exchange":"OKX","rate":0.0091,"annualized":9.97}],"openInterest":{"Binance":2150000000},"nextFundingTime":"2026-04-13T16:00:00Z"}
```

**When to use**: monitoring funding costs on your perpetual positions and timing entries. Essential for basis trading and funding cost management.

**Not for**: spot prices (use `dex_get_swap_quote`), yields (use `defi_find_best_yields`).

## Example agent prompts

- "Current perpetual futures funding rates for a single asset across exchanges"

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
