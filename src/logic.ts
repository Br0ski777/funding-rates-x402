import type { Hono } from "hono";

// In-memory cache with TTL
interface CacheEntry {
  data: any;
  timestamp: number;
}

const CACHE_TTL = 30 * 1000; // 30 seconds
const cache = new Map<string, CacheEntry>();

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
  try {
    const pair = `${symbol.toUpperCase()}USDT`;
    const resp = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`);
    if (!resp.ok) return null;
    const data = await resp.json() as any;

    const rate = parseFloat(data.lastFundingRate || "0");
    const markPrice = parseFloat(data.markPrice || "0");

    // Fetch open interest separately
    let openInterest: number | null = null;
    try {
      const oiResp = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`);
      if (oiResp.ok) {
        const oiData = await oiResp.json() as any;
        openInterest = parseFloat(oiData.openInterest || "0") * markPrice;
      }
    } catch {}

    return {
      exchange: "Binance",
      fundingRate: rate,
      fundingRatePercent: (rate * 100).toFixed(4) + "%",
      annualizedRate: (rate * 3 * 365 * 100).toFixed(2) + "%",
      nextFundingTime: data.nextFundingTime ? new Date(data.nextFundingTime).toISOString() : null,
      openInterest,
      markPrice,
    };
  } catch {
    return null;
  }
}

async function fetchBybit(symbol: string): Promise<ExchangeRate | null> {
  try {
    const pair = `${symbol.toUpperCase()}USDT`;
    const resp = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`);
    if (!resp.ok) return null;
    const data = await resp.json() as any;

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
  } catch {
    return null;
  }
}

async function fetchOKX(symbol: string): Promise<ExchangeRate | null> {
  try {
    const instId = `${symbol.toUpperCase()}-USDT-SWAP`;
    const resp = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`);
    if (!resp.ok) return null;
    const data = await resp.json() as any;

    const fundingData = data?.data?.[0];
    if (!fundingData) return null;

    const rate = parseFloat(fundingData.fundingRate || "0");

    // Fetch mark price and OI from ticker
    let markPrice: number | null = null;
    let openInterest: number | null = null;
    try {
      const tickerResp = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
      if (tickerResp.ok) {
        const tickerData = await tickerResp.json() as any;
        const ticker = tickerData?.data?.[0];
        if (ticker) {
          markPrice = parseFloat(ticker.last || "0");
        }
      }
      const oiResp = await fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`);
      if (oiResp.ok) {
        const oiData = await oiResp.json() as any;
        const oi = oiData?.data?.[0];
        if (oi && markPrice) {
          // OKX OI is in contracts; each contract = varying size depending on asset
          openInterest = parseFloat(oi.oi || "0") * markPrice;
        }
      }
    } catch {}

    return {
      exchange: "OKX",
      fundingRate: rate,
      fundingRatePercent: (rate * 100).toFixed(4) + "%",
      annualizedRate: (rate * 3 * 365 * 100).toFixed(2) + "%",
      nextFundingTime: fundingData.nextFundingTime ? new Date(parseInt(fundingData.nextFundingTime)).toISOString() : null,
      openInterest,
      markPrice,
    };
  } catch {
    return null;
  }
}

export function registerRoutes(app: Hono) {
  app.get("/api/rates", async (c) => {
    const symbol = c.req.query("symbol");

    if (!symbol) {
      return c.json({ error: "Missing required parameter: symbol (e.g. BTC, ETH, SOL)" }, 400);
    }

    const symbolUpper = symbol.toUpperCase();

    // Check cache
    const cacheKey = `rates:${symbolUpper}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return c.json(cached.data);
    }

    // Fetch from all exchanges in parallel
    const [binance, bybit, okx] = await Promise.all([
      fetchBinance(symbolUpper),
      fetchBybit(symbolUpper),
      fetchOKX(symbolUpper),
    ]);

    const rates: ExchangeRate[] = [];
    if (binance) rates.push(binance);
    if (bybit) rates.push(bybit);
    if (okx) rates.push(okx);

    if (rates.length === 0) {
      return c.json({
        symbol: symbolUpper,
        pair: `${symbolUpper}USDT`,
        found: false,
        exchanges: 0,
        message: `No funding rate data found for ${symbolUpper}. Make sure it has a USDT perpetual on Binance, Bybit, or OKX.`,
      }, 404);
    }

    // Calculate aggregates
    const fundingRates = rates.map((r) => r.fundingRate);
    const avgRate = fundingRates.reduce((a, b) => a + b, 0) / fundingRates.length;
    const maxRate = Math.max(...fundingRates);
    const minRate = Math.min(...fundingRates);
    const spread = maxRate - minRate;

    // Total open interest across exchanges
    const totalOI = rates.reduce((sum, r) => sum + (r.openInterest || 0), 0);

    // Consensus mark price (average of available)
    const markPrices = rates.filter((r) => r.markPrice).map((r) => r.markPrice!);
    const avgMarkPrice = markPrices.length > 0 ? markPrices.reduce((a, b) => a + b, 0) / markPrices.length : null;

    // Sentiment based on average rate
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

    // Cache result
    cache.set(cacheKey, { data: response, timestamp: Date.now() });

    return c.json(response);
  });
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
