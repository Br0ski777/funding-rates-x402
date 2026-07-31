import type { ApiConfig } from "./shared";

const TOOL_DESCRIPTION = `Use this to read perpetual futures funding rates. Two modes, same call, same price:

MARKET SCAN (omit symbol) -- returns every USDT perp on Binance and Bybit ranked by funding, so you can find an opportunity in one paid call instead of probing symbol by symbol. Sort by "abs" (largest magnitude, default), "highest" (shorts get paid most), "lowest" (longs get paid most) or "spread" (largest cross-venue gap = cash-and-carry candidates).

SINGLE SYMBOL (pass symbol) -- returns Binance, Bybit and OKX side by side for that asset, with open interest, mark price, next funding time and a sentiment read.

Data returned per market:
1. symbol: base ticker (BTC, ETH, SOL...)
2. venues: per-exchange funding rate, percent and annualized rate
3. avgRate / annualizedRate: mean funding across venues, annualized as rate * 3 * 365
4. direction: "short opportunity" when funding is positive (longs pay shorts), "long opportunity" when negative
5. spread / spreadAnnualized: gap between the cheapest and dearest venue
6. longVenue / shortVenue: where to take each leg of the cross-venue carry
7. openInterest, markPrice

Example scan output: {"scan":true,"totalMarkets":812,"venues":["Binance","Bybit"],"sort":"abs","markets":[{"symbol":"PEPE","venues":{"Binance":{"fundingRate":0.0005,"annualizedRate":54.75},"Bybit":{"fundingRate":0.0003,"annualizedRate":32.85}},"avgRate":0.0004,"annualizedRate":43.8,"direction":"short opportunity (longs pay shorts)","spread":0.0002,"spreadAnnualized":21.9,"longVenue":"Bybit","shortVenue":"Binance"}]}

Example single-symbol output: {"symbol":"ETH","found":true,"exchanges":3,"summary":{"averageRatePercent":"0.0082%","annualizedAverage":"8.98%","sentiment":"bullish (longs pay shorts)"},"rates":[{"exchange":"Binance","fundingRate":0.000082},{"exchange":"Bybit","fundingRate":0.000075},{"exchange":"OKX","fundingRate":0.000091}]}

Use this FOR finding carry and basis trades, timing perp entries, and monitoring funding costs on open positions.

Do NOT use for spot prices -- use dex_get_swap_quote instead. Do NOT use for DeFi yields -- use defi_find_best_yields instead. Do NOT use for Hyperliquid-specific rates -- use hyperliquid_get_funding_rates instead.

Note: market scans cover Binance and Bybit. OKX has no bulk funding-rate endpoint, so it is included only when you query a single symbol.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description:
        "Token symbol (e.g. BTC, ETH, SOL). Optional -- omit it to scan every market instead of one asset.",
    },
    sort: {
      type: "string",
      enum: ["abs", "highest", "lowest", "spread"],
      description:
        "Scan mode only. 'abs' = largest absolute funding first (default), 'highest' = most positive first, 'lowest' = most negative first, 'spread' = largest cross-venue gap first.",
    },
    limit: {
      type: "number",
      description: "Scan mode only. Number of markets to return. Default 50, max 1000.",
    },
    minVenues: {
      type: "number",
      description:
        "Scan mode only. Set to 2 to keep only markets listed on both venues, which is what cross-venue carry requires. Default 1.",
    },
  },
  required: [],
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scan: { type: "boolean", description: "True when the response is a market-wide scan" },
    found: { type: "boolean", description: "Whether data was found" },
    symbol: { type: "string", description: "Trading pair symbol (single-symbol mode)" },
    pair: { type: "string", description: "Full pair name (single-symbol mode)" },
    exchanges: { type: "number", description: "Number of exchanges with data (single-symbol mode)" },
    totalMarkets: { type: "number", description: "Number of markets matched (scan mode)" },
    venues: { type: "array", items: { type: "string" }, description: "Exchanges covered by the scan" },
    sort: { type: "string", description: "Sort order applied (scan mode)" },
    markets: {
      type: "array",
      description: "Ranked markets (scan mode)",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          venueCount: { type: "number" },
          avgRate: { type: "number" },
          annualizedRate: { type: "number" },
          direction: { type: "string" },
          spread: { type: "number" },
          spreadAnnualized: { type: "number" },
          longVenue: { type: "string" },
          shortVenue: { type: "string" },
          openInterest: { type: "number" },
          markPrice: { type: "number" },
        },
      },
    },
    rates: {
      type: "array",
      description: "Per-exchange rates (single-symbol mode)",
      items: {
        type: "object",
        properties: {
          exchange: { type: "string" },
          fundingRate: { type: "number" },
          annualizedRate: { type: "string" },
          nextFundingTime: { type: "string" },
        },
      },
    },
    timestamp: { type: "string" },
  },
  required: ["found"],
};

export const API_CONFIG: ApiConfig = {
  name: "funding-rates",
  slug: "funding-rates",
  description:
    "Perpetual funding rates across Binance, Bybit and OKX. Scan every market ranked by funding in one call, or query a single asset with open interest and predicted next rate.",
  version: "1.1.0",
  routes: [
    {
      method: "GET",
      path: "/api/rates",
      price: "$0.001",
      description: "Scan funding rates across all perp markets, or query a single asset",
      toolName: "perp_get_funding_rates",
      toolDescription: TOOL_DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
    },
    {
      method: "POST",
      path: "/api/rates",
      price: "$0.001",
      description: "Scan funding rates across all perp markets, or query a single asset (POST variant)",
      toolName: "perp_get_funding_rates",
      toolDescription:
        TOOL_DESCRIPTION +
        `

POST variant of perp_get_funding_rates -- same params passed as a JSON body instead of a query string. Send {} to get the default market-wide scan.`,
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
    },
  ],
};
