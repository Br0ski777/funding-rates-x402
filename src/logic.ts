import type { Hono } from "hono";


// ATXP: requirePayment only fires inside an ATXP context (set by atxpHono middleware).
// For raw x402 requests, the existing @x402/hono middleware handles the gate.
// If neither protocol is active (ATXP_CONNECTION unset), tryRequirePayment is a no-op.
async function tryRequirePayment(price: number): Promise<void> {
  if (!process.env.ATXP_CONNECTION) return;
  try {
    const { requirePayment } = await import("@atxp/server");
    const BigNumber = (await import("bignumber.js")).default;
    await requirePayment({ price: BigNumber(price) });
  } catch (e: any) {
    if (e?.code === -30402) throw e;
  }
}

// In-memory cache with TTL
interface CacheEntry {
  data: any;
  timestamp: number;
}

const CACHE_TTL = 30 * 1000; // 30 seconds
const cache = new Map<string, CacheEntry>();

// Upstream budget per exchange call. Without it a single hanging exchange
// stalls the whole paid request (fetch has no default timeout).
const UPSTREAM_TIMEOUT_MS = 2500;

// Hot-symbol prewarm: a symbol asked for recently is refreshed in the
// background so the next paid call hits the cache instead of waiting on
// three exchanges. Self-limiting -- with no traffic, nothing is refreshed.
const PREWARM_INTERVAL_MS = 25 * 1000;
const PREWARM_WINDOW_MS = 5 * 60 * 1000; // only symbols seen in the last 5 min
const PREWARM_MAX_SYMBOLS = 5; // caps upstream load (~1.2 req/s worst case)
const lastRequested = new Map<string, number>();

function timeout(): AbortSignal {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const resp = await fetch(url, { signal: timeout() });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

interface ExchangeRate {
  exchange: string;
  fundingRate: number;
  fundingRatePercent: string;
  annualizedRate: string;
  nextFundingTime: string | null;
  openInterest: number | null;
  markPrice: number | null;
}

async function fetchBinance(symbol: string): Promise<ExchangeRate | null> {
  const pair = `${symbol.toUpperCase()}USDT`;

  // Both calls are independent -- issue them together rather than chaining.
  const [data, oiData] = await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`),
  ]);

  if (!data) return null;

  const rate = parseFloat(data.lastFundingRate || "0");
  const markPrice = parseFloat(data.markPrice || "0");

  let openInterest: number | null = null;
  if (oiData) {
    openInterest = parseFloat(oiData.openInterest || "0") * markPrice;
  }

  return {
    exchange: "Binance",
    fundingRate: rate,
    fundingRatePercent: (rate * 100).toFixed(4) + "%",
    annualizedRate: (rate * 3 * 365 * 100).toFixed(2) + "%",
    nextFundingTime: data.nextFundingTime ? new Date(data.nextFundingTime).toISOString() : null,
    openInterest,
    markPrice,
  };
}

async function fetchBybit(symbol: string): Promise<ExchangeRate | null> {
  const pair = `${symbol.toUpperCase()}USDT`;
  const data = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`);
  if (!data) return null;

  const ticker = data?.result?.list?.[0];
  if (!ticker) return null;

  const rate = parseFloat(ticker.fundingRate || "0");
  const markPrice = parseFloat(ticker.markPrice || "0");
  const openInterest = parseFloat(ticker.openInterest || "0") * markPrice;

  return {
    exchange: "Bybit",
    fundingRate: rate,
    fundingRatePercent: (rate * 100).toFixed(4) + "%",
    annualizedRate: (rate * 3 * 365 * 100).toFixed(2) + "%",
    nextFundingTime: ticker.nextFundingTime ? new Date(parseInt(ticker.nextFundingTime)).toISOString() : null,
    openInterest: openInterest || null,
    markPrice,
  };
}

async function fetchOKX(symbol: string): Promise<ExchangeRate | null> {
  const instId = `${symbol.toUpperCase()}-USDT-SWAP`;

  // The three OKX calls used to run back to back, which made OKX the slowest
  // leg and therefore the ceiling for the whole handler. They do not depend on
  // each other -- only the openInterest maths needs markPrice, and that can be
  // applied once both have resolved.
  const [fundingResp, tickerData, oiData] = await Promise.all([
    fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
    fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
    fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
  ]);

  const fundingData = fundingResp?.data?.[0];
  if (!fundingData) return null;

  const rate = parseFloat(fundingData.fundingRate || "0");

  let markPrice: number | null = null;
  const ticker = tickerData?.data?.[0];
  if (ticker) {
    markPrice = parseFloat(ticker.last || "0");
  }

  let openInterest: number | null = null;
  const oi = oiData?.data?.[0];
  if (oi && markPrice) {
    // OKX OI is in contracts; each contract = varying size depending on asset
    openInterest = parseFloat(oi.oi || "0") * markPrice;
  }

  return {
    exchange: "OKX",
    fundingRate: rate,
    fundingRatePercent: (rate * 100).toFixed(4) + "%",
    annualizedRate: (rate * 3 * 365 * 100).toFixed(2) + "%",
    nextFundingTime: fundingData.nextFundingTime ? new Date(parseInt(fundingData.nextFundingTime)).toISOString() : null,
    openInterest,
    markPrice,
  };
}

// Builds the payload for a symbol and stores it in the cache.
// Returns null when no exchange had data for that symbol.
async function buildRates(symbolUpper: string): Promise<any | null> {
  const [binance, bybit, okx] = await Promise.all([
    fetchBinance(symbolUpper),
    fetchBybit(symbolUpper),
    fetchOKX(symbolUpper),
  ]);

  const rates: ExchangeRate[] = [];
  if (binance) rates.push(binance);
  if (bybit) rates.push(bybit);
  if (okx) rates.push(okx);

  if (rates.length === 0) return null;

  const fundingRates = rates.map((r) => r.fundingRate);
  const avgRate = fundingRates.reduce((a, b) => a + b, 0) / fundingRates.length;
  const maxRate = Math.max(...fundingRates);
  const minRate = Math.min(...fundingRates);
  const spread = maxRate - minRate;

  const totalOI = rates.reduce((sum, r) => sum + (r.openInterest || 0), 0);

  const markPrices = rates.filter((r) => r.markPrice).map((r) => r.markPrice!);
  const avgMarkPrice = markPrices.length > 0 ? markPrices.reduce((a, b) => a + b, 0) / markPrices.length : null;

  let sentiment: string;
  if (avgRate > 0.0003) sentiment = "very bullish (longs pay shorts)";
  else if (avgRate > 0.0001) sentiment = "bullish (longs pay shorts)";
  else if (avgRate > -0.0001) sentiment = "neutral";
  else if (avgRate > -0.0003) sentiment = "bearish (shorts pay longs)";
  else sentiment = "very bearish (shorts pay longs)";

  const response = {
    symbol: symbolUpper,
    pair: `${symbolUpper}USDT`,
    found: true,
    exchanges: rates.length,
    summary: {
      averageRate: avgRate,
      averageRatePercent: (avgRate * 100).toFixed(4) + "%",
      annualizedAverage: (avgRate * 3 * 365 * 100).toFixed(2) + "%",
      maxRate: (maxRate * 100).toFixed(4) + "%",
      minRate: (minRate * 100).toFixed(4) + "%",
      spread: (spread * 100).toFixed(4) + "%",
      sentiment,
      totalOpenInterest: totalOI > 0 ? totalOI : null,
      totalOpenInterestFormatted: totalOI > 0 ? formatUsd(totalOI) : null,
      markPrice: avgMarkPrice,
    },
    rates,
    cachedUntil: new Date(Date.now() + CACHE_TTL).toISOString(),
  };

  cache.set(`rates:${symbolUpper}`, { data: response, timestamp: Date.now() });
  return response;
}

// Keeps recently requested symbols warm so paid calls skip the upstream leg.
let prewarmStarted = false;
function startPrewarm() {
  if (prewarmStarted) return;
  prewarmStarted = true;

  setInterval(() => {
    const now = Date.now();
    const hot: string[] = [];

    for (const [symbol, seen] of lastRequested) {
      if (now - seen > PREWARM_WINDOW_MS) {
        lastRequested.delete(symbol);
      } else {
        hot.push(symbol);
      }
    }

    // Most recently requested first, so the busiest symbols stay warm.
    hot.sort((a, b) => (lastRequested.get(b) || 0) - (lastRequested.get(a) || 0));

    for (const symbol of hot.slice(0, PREWARM_MAX_SYMBOLS)) {
      buildRates(symbol).catch(() => {});
    }
  }, PREWARM_INTERVAL_MS).unref?.();
}

export function registerRoutes(app: Hono) {
  startPrewarm();

  async function handleRates(c: any, params: { symbol?: string }) {
    await tryRequirePayment(0.005);
    const symbol = params.symbol;

    if (!symbol) {
      return c.json({ error: "Missing required parameter: symbol (e.g. BTC, ETH, SOL)" }, 400);
    }

    const symbolUpper = symbol.toUpperCase();
    lastRequested.set(symbolUpper, Date.now());

    // Check cache
    const cacheKey = `rates:${symbolUpper}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return c.json(cached.data);
    }

    const response = await buildRates(symbolUpper);

    if (!response) {
      return c.json({
        symbol: symbolUpper,
        pair: `${symbolUpper}USDT`,
        found: false,
        exchanges: 0,
        message: `No funding rate data found for ${symbolUpper}. Make sure it has a USDT perpetual on Binance, Bybit, or OKX.`,
      }, 404);
    }

    return c.json(response);
  }

  app.get("/api/rates", async (c) => {
    return handleRates(c, { symbol: c.req.query("symbol") });
  });

  // POST mirror of the GET route above -- Bazaar (CDP) only reliably indexes
  // POST payments with valid payloads (~82% conversion vs ~14% for GET-only
  // resources, confirmed empirically). Same params, same logic, just body
  // instead of query string.
  app.post("/api/rates", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    return handleRates(c, { symbol: body.symbol });
  });
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
