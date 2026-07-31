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

// Keep in sync with the route price in config.ts -- this is the ATXP channel,
// the raw x402 gate reads config.ts directly.
const PRICE_USD = 0.001;

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

// The market-wide scan pulls ~850 markets per venue, so it gets a longer
// budget than a single-symbol lookup.
const SCAN_TIMEOUT_MS = 6000;

// Hot-symbol prewarm: a symbol asked for recently is refreshed in the
// background so the next paid call hits the cache instead of waiting on
// three exchanges. Self-limiting -- with no traffic, nothing is refreshed.
const PREWARM_INTERVAL_MS = 25 * 1000;
const PREWARM_WINDOW_MS = 5 * 60 * 1000; // only symbols seen in the last 5 min
const PREWARM_MAX_SYMBOLS = 5; // caps upstream load (~1.2 req/s worst case)
const lastRequested = new Map<string, number>();

// Scan defaults. An agent hunting for an opportunity wants the top of the
// book, not 850 rows -- but the cap is high enough to take the whole market.
const SCAN_DEFAULT_LIMIT = 50;
const SCAN_MAX_LIMIT = 1000;
let scanRequestedAt = 0;

function timeout(ms: number = UPSTREAM_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function fetchJson(url: string, ms?: number): Promise<any | null> {
  try {
    const resp = await fetch(url, { signal: timeout(ms) });
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

// --- Market-wide scan -------------------------------------------------------
// Binance and Bybit both return every perp in a single response, so the whole
// market costs two upstream calls rather than one per symbol. OKX has no bulk
// funding-rate endpoint (instId is mandatory), so it stays out of the scan and
// is only used for single-symbol lookups.

interface VenueQuote {
  fundingRate: number;
  annualizedRate: number;
  markPrice: number | null;
  openInterest: number | null;
  nextFundingTime: string | null;
}

function baseSymbol(pair: string): string | null {
  if (!pair.endsWith("USDT")) return null;
  const base = pair.slice(0, -4);
  return base.length > 0 ? base : null;
}

function annualize(rate: number): number {
  // Funding settles every 8h on all three venues -> 3 periods per day.
  return rate * 3 * 365 * 100;
}

async function fetchBinanceAll(): Promise<Map<string, VenueQuote>> {
  const out = new Map<string, VenueQuote>();
  const data = await fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex", SCAN_TIMEOUT_MS);
  if (!Array.isArray(data)) return out;

  for (const row of data) {
    const symbol = baseSymbol(row?.symbol || "");
    if (!symbol) continue;
    const rate = parseFloat(row.lastFundingRate ?? "0");
    if (!Number.isFinite(rate)) continue;
    const markPrice = parseFloat(row.markPrice ?? "0") || null;
    out.set(symbol, {
      fundingRate: rate,
      annualizedRate: annualize(rate),
      markPrice,
      // premiumIndex carries no open interest; per-symbol OI would be one
      // call per market, which defeats the point of a single-call scan.
      openInterest: null,
      nextFundingTime: row.nextFundingTime ? new Date(row.nextFundingTime).toISOString() : null,
    });
  }
  return out;
}

async function fetchBybitAll(): Promise<Map<string, VenueQuote>> {
  const out = new Map<string, VenueQuote>();
  const data = await fetchJson("https://api.bybit.com/v5/market/tickers?category=linear", SCAN_TIMEOUT_MS);
  const list = data?.result?.list;
  if (!Array.isArray(list)) return out;

  for (const row of list) {
    const symbol = baseSymbol(row?.symbol || "");
    if (!symbol) continue;
    const rate = parseFloat(row.fundingRate ?? "");
    if (!Number.isFinite(rate)) continue;
    const markPrice = parseFloat(row.markPrice ?? "0") || null;
    const oiContracts = parseFloat(row.openInterest ?? "0");
    out.set(symbol, {
      fundingRate: rate,
      annualizedRate: annualize(rate),
      markPrice,
      openInterest: Number.isFinite(oiContracts) && markPrice ? oiContracts * markPrice : null,
      nextFundingTime: row.nextFundingTime ? new Date(parseInt(row.nextFundingTime)).toISOString() : null,
    });
  }
  return out;
}

// Builds the full unsorted market table and caches it. Sorting and limiting
// are applied per request, so different sort orders share one upstream fetch.
async function buildScan(): Promise<any[] | null> {
  const [binance, bybit] = await Promise.all([fetchBinanceAll(), fetchBybitAll()]);
  if (binance.size === 0 && bybit.size === 0) return null;

  const symbols = new Set<string>([...binance.keys(), ...bybit.keys()]);
  const markets: any[] = [];

  for (const symbol of symbols) {
    const venues: Record<string, VenueQuote> = {};
    const b = binance.get(symbol);
    const y = bybit.get(symbol);
    if (b) venues.Binance = b;
    if (y) venues.Bybit = y;

    const quotes = Object.entries(venues);
    if (quotes.length === 0) continue;

    const rates = quotes.map(([, q]) => q.fundingRate);
    const avgRate = rates.reduce((a, c) => a + c, 0) / rates.length;

    let spread: number | null = null;
    let longVenue: string | null = null;
    let shortVenue: string | null = null;
    if (quotes.length > 1) {
      const sorted = [...quotes].sort((a, c) => a[1].fundingRate - c[1].fundingRate);
      // Long where funding is cheapest, short where it pays the most.
      longVenue = sorted[0][0];
      shortVenue = sorted[sorted.length - 1][0];
      spread = sorted[sorted.length - 1][1].fundingRate - sorted[0][1].fundingRate;
    }

    const markPrices = quotes.map(([, q]) => q.markPrice).filter((p): p is number => !!p);
    const ois = quotes.map(([, q]) => q.openInterest).filter((o): o is number => !!o);

    markets.push({
      symbol,
      venueCount: quotes.length,
      venues: Object.fromEntries(
        quotes.map(([name, q]) => [
          name,
          {
            fundingRate: q.fundingRate,
            fundingRatePercent: (q.fundingRate * 100).toFixed(4) + "%",
            annualizedRate: Number(q.annualizedRate.toFixed(2)),
            nextFundingTime: q.nextFundingTime,
          },
        ]),
      ),
      avgRate,
      avgRatePercent: (avgRate * 100).toFixed(4) + "%",
      annualizedRate: Number(annualize(avgRate).toFixed(2)),
      direction: avgRate >= 0 ? "short opportunity (longs pay shorts)" : "long opportunity (shorts pay longs)",
      spread,
      spreadPercent: spread === null ? null : (spread * 100).toFixed(4) + "%",
      spreadAnnualized: spread === null ? null : Number(annualize(spread).toFixed(2)),
      longVenue,
      shortVenue,
      markPrice: markPrices.length ? markPrices.reduce((a, c) => a + c, 0) / markPrices.length : null,
      openInterest: ois.length ? ois.reduce((a, c) => a + c, 0) : null,
    });
  }

  cache.set("scan:all", { data: markets, timestamp: Date.now() });
  return markets;
}

function sortMarkets(markets: any[], sort: string): any[] {
  const rows = [...markets];
  switch (sort) {
    case "highest":
      return rows.sort((a, b) => b.avgRate - a.avgRate);
    case "lowest":
      return rows.sort((a, b) => a.avgRate - b.avgRate);
    case "spread":
      return rows.sort((a, b) => Math.abs(b.spread ?? 0) - Math.abs(a.spread ?? 0));
    case "abs":
    default:
      return rows.sort((a, b) => Math.abs(b.avgRate) - Math.abs(a.avgRate));
  }
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

    // Same idea for the scan: only refreshed while somebody is actually asking
    // for it, so an idle container issues no upstream traffic at all.
    if (now - scanRequestedAt < PREWARM_WINDOW_MS) {
      buildScan().catch(() => {});
    }
  }, PREWARM_INTERVAL_MS).unref?.();
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

export function registerRoutes(app: Hono) {
  startPrewarm();

  async function handleScan(c: any, params: { sort?: string; limit?: any; minVenues?: any }) {
    scanRequestedAt = Date.now();

    const sort = ["abs", "highest", "lowest", "spread"].includes(String(params.sort))
      ? String(params.sort)
      : "abs";

    const rawLimit = parseInt(String(params.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), SCAN_MAX_LIMIT)
      : SCAN_DEFAULT_LIMIT;

    const rawMinVenues = parseInt(String(params.minVenues ?? ""), 10);
    const minVenues = Number.isFinite(rawMinVenues) ? Math.min(Math.max(rawMinVenues, 1), 2) : 1;

    const cached = cache.get("scan:all");
    let markets: any[] | null;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      markets = cached.data;
    } else {
      markets = await buildScan();
    }

    if (!markets) {
      return c.json(
        { scan: true, found: false, message: "No exchange returned funding data. Upstreams may be rate limiting." },
        503,
      );
    }

    const filtered = markets.filter((m) => m.venueCount >= minVenues);

    return c.json({
      scan: true,
      found: true,
      totalMarkets: filtered.length,
      venues: ["Binance", "Bybit"],
      sort,
      limit,
      minVenues,
      note: "Market-wide scans cover Binance and Bybit. OKX has no bulk funding-rate endpoint, so it is only included when you query a single symbol.",
      markets: sortMarkets(filtered, sort).slice(0, limit),
      timestamp: new Date().toISOString(),
      cachedUntil: new Date(Date.now() + CACHE_TTL).toISOString(),
    });
  }

  async function handleRates(c: any, params: { symbol?: string; sort?: string; limit?: any; minVenues?: any }) {
    await tryRequirePayment(PRICE_USD);
    const symbol = params.symbol;

    // No symbol means "show me the whole market". An agent hunting for a
    // funding opportunity should not have to pay per symbol to find one.
    if (!symbol) {
      return handleScan(c, params);
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
    return handleRates(c, {
      symbol: c.req.query("symbol"),
      sort: c.req.query("sort"),
      limit: c.req.query("limit"),
      minVenues: c.req.query("minVenues"),
    });
  });

  // POST mirror of the GET route above -- Bazaar (CDP) only reliably indexes
  // POST payments with valid payloads (~82% conversion vs ~14% for GET-only
  // resources, confirmed empirically). Same params, same logic, just body
  // instead of query string.
  app.post("/api/rates", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    return handleRates(c, {
      symbol: body.symbol,
      sort: body.sort,
      limit: body.limit,
      minVenues: body.minVenues,
    });
  });
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
