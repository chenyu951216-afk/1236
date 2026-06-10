import { asArray, responseData, runLimited, toFiniteNumber } from "./util.js";

const BASE_URL = "https://open-api-v4.coinglass.com";
const CACHE_TTL_MS = 10 * 60 * 1000;
const VALID_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "6h", "8h", "12h", "1d", "1w"]);
const VALID_LIQUIDATION_RANGES = new Set(["1h", "4h", "12h", "24h"]);

export class CoinGlassClient {
  constructor(config) {
    this.apiKey = config.coinglassApiKey;
    this.timeoutMs = config.requestTimeoutMs;
    this.defaultExchange = config.defaultExchange;
    this.defaultQuote = config.defaultQuote;
    this.defaultInterval = VALID_INTERVALS.has(config.defaultInterval)
      ? config.defaultInterval
      : "4h";
    this.historyLimit = config.historyLimit;
    this.aggregatedExchanges = config.aggregatedExchanges;
    this.liquidationRange = VALID_LIQUIDATION_RANGES.has(config.liquidationRange)
      ? config.liquidationRange
      : "24h";
    this.concurrency = config.coinglassConcurrency;
    this.cache = new Map();
  }

  async request(path, params = {}) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "CG-API-KEY": this.apiKey,
        },
        signal: controller.signal,
      });

      const text = await response.text();
      const body = tryParseJson(text);
      const durationMs = Date.now() - startedAt;
      const rateLimit = {
        max: response.headers.get("API-KEY-MAX-LIMIT"),
        used: response.headers.get("API-KEY-USE-LIMIT"),
      };

      const apiCode = body && typeof body === "object" ? body.code : undefined;
      const ok = response.ok && (apiCode === undefined || String(apiCode) === "0");

      return {
        ok,
        status: response.status,
        path,
        params,
        durationMs,
        rateLimit,
        body,
        error: ok ? null : buildApiError(response.status, body, text),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        path,
        params,
        durationMs: Date.now() - startedAt,
        rateLimit: {},
        body: null,
        error: error.name === "AbortError" ? "Request timed out" : error.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async cached(key, producer) {
    const current = this.cache.get(key);
    if (current && Date.now() - current.savedAt < CACHE_TTL_MS) return current.value;
    const value = await producer();
    this.cache.set(key, { value, savedAt: Date.now() });
    return value;
  }

  async getSupportedCoins() {
    return this.cached("supported-coins", async () => {
      const result = await this.request("/api/futures/supported-coins");
      if (!result.ok) return { ok: false, result, coins: new Set() };
      const coins = new Set(asArray(responseData(result.body)).map((coin) => String(coin).toUpperCase()));
      return { ok: true, result, coins };
    });
  }

  async getExchangePairs(exchange = this.defaultExchange) {
    return this.cached(`exchange-pairs:${exchange.toLowerCase()}`, async () => {
      const result = await this.request("/api/futures/supported-exchange-pairs", { exchange });
      if (!result.ok) return { ok: false, result, pairs: [] };

      const data = responseData(result.body);
      if (Array.isArray(data)) return { ok: true, result, pairs: data };

      const exchangeKey = Object.keys(data || {}).find(
        (key) => key.toLowerCase() === exchange.toLowerCase(),
      );
      return { ok: true, result, pairs: asArray(data?.[exchangeKey] ?? []) };
    });
  }

  parseSymbol(input) {
    let token = String(input ?? "")
      .trim()
      .replace(/^[$#]/, "")
      .toUpperCase();

    token = token.replace(/[^A-Z0-9_/-]/g, "").replace(/[_/-]/g, "");
    token = token.replace(/PERP$/, "");

    for (const quote of ["USDT", "USDC", "BUSD", "USD"]) {
      if (token.length > quote.length + 1 && token.endsWith(quote)) {
        token = token.slice(0, -quote.length);
        break;
      }
    }

    if (!/^[A-Z0-9]{2,20}$/.test(token)) return null;
    return token;
  }

  async normalizeSymbol(input, { exchange = this.defaultExchange, requireSupported = true } = {}) {
    const coin = this.parseSymbol(input);
    if (!coin) {
      return { ok: false, reason: "invalid_symbol", input };
    }

    const supported = await this.getSupportedCoins();
    if (requireSupported && supported.ok && !supported.coins.has(coin)) {
      return { ok: false, reason: "unsupported_symbol", input, coin };
    }

    const pair = await this.resolveFuturesPair(coin, exchange);
    return {
      ok: true,
      input,
      coin,
      exchange,
      pair,
      supportedCoinsAvailable: supported.ok,
    };
  }

  async resolveFuturesPair(coin, exchange = this.defaultExchange) {
    const fallback = `${coin}${this.defaultQuote}`;
    const pairResult = await this.getExchangePairs(exchange);
    if (!pairResult.ok || !pairResult.pairs.length) return fallback;

    const candidates = pairResult.pairs
      .map((item) => normalizeInstrument(item))
      .filter((item) => item.base === coin);

    if (!candidates.length) return fallback;

    candidates.sort((a, b) => scoreInstrument(b, coin, this.defaultQuote) - scoreInstrument(a, coin, this.defaultQuote));
    return candidates[0].id || fallback;
  }

  async buildFuturesBundle({ coin, pair, exchange, interval, limit, liquidationRange }) {
    const safeInterval = VALID_INTERVALS.has(interval) ? interval : this.defaultInterval;
    const safeLimit = Number.isFinite(limit) ? Math.max(5, Math.min(limit, 1000)) : this.historyLimit;
    const safeLiquidationRange = VALID_LIQUIDATION_RANGES.has(liquidationRange)
      ? liquidationRange
      : this.liquidationRange;
    const exchangeList = this.aggregatedExchanges.join(",");

    const endpoints = [
      {
        key: "pairsMarkets",
        label: "Futures Pairs Markets",
        path: "/api/futures/pairs-markets",
        params: { symbol: coin },
      },
      {
        key: "openInterestExchangeList",
        label: "Open Interest By Exchange",
        path: "/api/futures/open-interest/exchange-list",
        params: { symbol: coin },
      },
      {
        key: "fundingRateExchangeList",
        label: "Funding Rate By Exchange",
        path: "/api/futures/funding-rate/exchange-list",
        params: {},
        filter: (body) => filterRowsBySymbol(body, coin),
      },
      {
        key: "liquidationExchangeList",
        label: "Liquidation By Exchange",
        path: "/api/futures/liquidation/exchange-list",
        params: { symbol: coin, range: safeLiquidationRange },
      },
      {
        key: "priceHistory",
        label: "Price OHLC History",
        path: "/api/futures/price/history",
        params: { exchange, symbol: pair, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "openInterestAggregatedHistory",
        label: "Aggregated Open Interest History",
        path: "/api/futures/open-interest/aggregated-history",
        params: { symbol: coin, interval: safeInterval, limit: safeLimit, unit: "usd" },
      },
      {
        key: "liquidationAggregatedHistory",
        label: "Aggregated Liquidation History",
        path: "/api/futures/liquidation/aggregated-history",
        params: { exchange_list: exchangeList, symbol: coin, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "takerBuySellHistory",
        label: "Aggregated Taker Buy/Sell History",
        path: "/api/futures/aggregated-taker-buy-sell-volume/history",
        params: { exchange_list: exchangeList, symbol: coin, interval: safeInterval, limit: safeLimit, unit: "usd" },
      },
      {
        key: "globalAccountRatio",
        label: "Global Long/Short Account Ratio",
        path: "/api/futures/global-long-short-account-ratio/history",
        params: { exchange, symbol: pair, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "topAccountRatio",
        label: "Top Trader Account Ratio",
        path: "/api/futures/top-long-short-account-ratio/history",
        params: { exchange, symbol: pair, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "topPositionRatio",
        label: "Top Trader Position Ratio",
        path: "/api/futures/top-long-short-position-ratio/history",
        params: { exchange, symbol: pair, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "aggregatedCvdHistory",
        label: "Aggregated CVD History",
        path: "/api/futures/aggregated-cvd/history",
        params: { exchange_list: exchangeList, symbol: coin, interval: safeInterval, limit: safeLimit, unit: "usd" },
      },
      {
        key: "netPositionHistory",
        label: "Net Long/Short Position V2",
        path: "/api/futures/v2/net-position/history",
        params: { exchange, symbol: pair, interval: safeInterval, limit: safeLimit },
      },
      {
        key: "rsiList",
        label: "RSI List",
        path: "/api/futures/rsi/list",
        params: {},
        filter: (body) => filterRowsBySymbol(body, coin),
      },
      {
        key: "macdList",
        label: "MACD List",
        path: "/api/futures/macd/list",
        params: {},
        filter: (body) => filterRowsBySymbol(body, coin),
      },
      {
        key: "emaList",
        label: "EMA List",
        path: "/api/futures/ema/list",
        params: {},
        filter: (body) => filterRowsBySymbol(body, coin),
      },
      {
        key: "maList",
        label: "MA List",
        path: "/api/futures/ma/list",
        params: {},
        filter: (body) => filterRowsBySymbol(body, coin),
      },
    ];

    const endpointResults = await runLimited(endpoints, this.concurrency, async (endpoint) => {
      const result = await this.request(endpoint.path, endpoint.params);
      const body = result.ok && endpoint.filter ? endpoint.filter(result.body) : result.body;
      return {
        key: endpoint.key,
        label: endpoint.label,
        ok: result.ok,
        status: result.status,
        path: result.path,
        params: result.params,
        durationMs: result.durationMs,
        rateLimit: result.rateLimit,
        error: result.error,
        body,
      };
    });

    return {
      meta: {
        requestedAt: new Date().toISOString(),
        coin,
        pair,
        exchange,
        interval: safeInterval,
        limit: safeLimit,
        liquidationRange: safeLiquidationRange,
        aggregatedExchanges: this.aggregatedExchanges,
        baseUrl: BASE_URL,
      },
      endpoints: endpointResults,
    };
  }
}

function normalizeInstrument(item) {
  const id = String(item.instrument_id ?? item.instrumentId ?? item.symbol ?? "");
  return {
    id,
    base: String(item.base_asset ?? item.baseAsset ?? "").toUpperCase(),
    quote: String(item.quote_asset ?? item.quoteAsset ?? "").toUpperCase(),
    settlement: String(item.settlement_currency ?? item.settlementCurrency ?? "").toUpperCase(),
  };
}

function scoreInstrument(item, coin, quote) {
  const id = item.id.toUpperCase();
  let score = 0;
  if (item.base === coin) score += 100;
  if (item.quote === quote) score += 40;
  if (item.settlement === quote) score += 20;
  if (id === `${coin}${quote}`) score += 60;
  if (id.includes("PERP") || id.includes("SWAP")) score += 25;
  if (!/_?\d{6,8}$/.test(id)) score += 15;
  if (id.includes(quote)) score += 10;
  return score;
}

function filterRowsBySymbol(body, coin) {
  if (!body || typeof body !== "object") return body;
  const data = responseData(body);
  const filtered = asArray(data).filter(
    (row) => String(row?.symbol ?? row?.base_asset ?? "").toUpperCase() === coin,
  );
  return { ...body, data: filtered };
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildApiError(status, body, text) {
  if (body && typeof body === "object") {
    return body.msg || body.message || body.error || `CoinGlass returned HTTP ${status}`;
  }
  return text ? String(text).slice(0, 500) : `CoinGlass returned HTTP ${status}`;
}

export function parseRequestOptions(tokens, config) {
  const options = {
    exchange: config.defaultExchange,
    interval: config.defaultInterval,
    limit: config.historyLimit,
    liquidationRange: config.liquidationRange,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    const next = tokens[index + 1];

    if ((lower === "--exchange" || lower === "-e") && next) {
      options.exchange = next;
      index += 1;
    } else if ((lower === "--interval" || lower === "-i") && next && VALID_INTERVALS.has(next.toLowerCase())) {
      options.interval = next.toLowerCase();
      index += 1;
    } else if ((lower === "--limit" || lower === "-l") && next) {
      const parsed = toFiniteNumber(next);
      if (parsed !== null) options.limit = Math.max(5, Math.min(Math.floor(parsed), 1000));
      index += 1;
    } else if ((lower === "--range" || lower === "-r") && next && VALID_LIQUIDATION_RANGES.has(next.toLowerCase())) {
      options.liquidationRange = next.toLowerCase();
      index += 1;
    }
  }

  return options;
}
