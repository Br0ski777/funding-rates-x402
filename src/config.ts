import type { ApiConfig } from "./shared";

export const API_CONFIG: ApiConfig = {
  name: "funding-rates",
  slug: "funding-rates",
  description: "Live perpetual funding rates across Binance, Bybit, OKX -- open interest and predicted next rate included.",
  version: "1.0.0",
  routes: [
    {
      method: "GET",
      path: "/api/rates",
      price: "$0.002",
      description: "Get perpetual futures funding rates across exchanges",
      toolName: "perp_get_funding_rates",
      toolDescription: `Use this when you need current perpetual futures funding rates for a single asset across exchanges. Returns rates comparison in JSON.

1. symbol: trading pair symbol
2. rates: array per exchange with exchange name, current funding rate, annualized rate
3. openInterest: open interest in USD per exchange
4. predictedNextRate: predicted next funding rate per exchange
5. nextFundingTime: timestamp of next funding event

Example output: {"symbol":"ETH","rates":[{"exchange":"Binance","rate":0.0082,"annualized":8.98},{"exchange":"Bybit","rate":0.0075,"annualized":8.21},{"exchange":"OKX","rate":0.0091,"annualized":9.97}],"openInterest":{"Binance":2150000000},"nextFundingTime":"2026-04-13T16:00:00Z"}

Use this FOR monitoring funding costs on your perpetual positions and timing entries. Essential for basis trading and funding cost management.

Do NOT use for spot prices -- use dex_get_swap_quote instead. Do NOT use for yields -- use defi_find_best_yields instead. Do NOT use for cross-exchange arbitrage scanning -- use perp_scan_funding_arbitrage instead.`,
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Token symbol (e.g. BTC, ETH, SOL)" },
        },
        required: ["symbol"],
      },
      outputSchema: {
          "type": "object",
          "properties": {
            "symbol": {
              "type": "string",
              "description": "Trading pair symbol"
            },
            "pair": {
              "type": "string",
              "description": "Full pair name"
            },
            "found": {
              "type": "boolean",
              "description": "Whether rates were found"
            },
            "exchanges": {
              "type": "number",
              "description": "Number of exchanges with data"
            },
            "rates": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "exchange": {
                    "type": "string"
                  },
                  "fundingRate": {
                    "type": "number"
                  },
                  "annualized": {
                    "type": "number"
                  },
                  "nextFunding": {
                    "type": "string"
                  }
                }
              }
            },
            "timestamp": {
              "type": "string"
            }
          },
          "required": [
            "symbol",
            "found"
          ]
        },
    },
  ],
};
