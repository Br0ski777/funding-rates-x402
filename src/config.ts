import type { ApiConfig } from "./shared";

export const API_CONFIG: ApiConfig = {
  name: "funding-rates",
  slug: "funding-rates",
  description: "Real-time perpetual funding rates across Binance, Bybit, and OKX.",
  version: "1.0.0",
  routes: [
    {
      method: "GET",
      path: "/api/rates",
      price: "$0.002",
      description: "Get perpetual futures funding rates across exchanges",
      toolName: "perp_get_funding_rates",
      toolDescription: "Use this when you need current perpetual futures funding rates. Returns rates across Binance, Bybit, and OKX for any trading pair, plus open interest and predicted next funding. Do NOT use for spot prices — use dex_get_swap_quote. Do NOT use for yields — use defi_find_best_yields.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Token symbol (e.g. BTC, ETH, SOL)" },
        },
        required: ["symbol"],
      },
    },
  ],
};
