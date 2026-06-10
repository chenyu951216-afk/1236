import { asArray, runLimited, toFiniteNumber } from "./util.js";

const BINANCE_FAPI_BASE = "https://fapi.binance.com";

export class ExchangeSupplementClient {
  constructor(config) {
    this.enabled = config.enableExchangeSupplement;
    this.timeoutMs = config.requestTimeoutMs;
    this.defaultQuote = config.defaultQuote;
    this.secondaryInterval = config.secondaryInterval;
    this.secondaryLimit = config.secondaryLimit;
    this.orderBookLimit = config.orderBookLimit;
    this.concurrency = config.coinglassConcurrency;
  }

  async build({ coin, pair }) {
    if (!this.enabled) return null;

    const symbol = toBinanceSymbol(pair, coin, this.defaultQuote);
    if (!symbol) {
      return {
        source: "Binance USD-M Futures",
        ok: false,
        symbol: null,
        error: "Unable to resolve Binance USD-M futures symbol",
        endpoints: [],
      };
    }

    const endpoints = [
      {
        key: "ticker24h",
        label: "Binance 24h Ticker",
        path: "/fapi/v1/ticker/24hr",
        params: { symbol },
      },
      {
        key: "premiumIndex",
        label: "Binance Premium Index / Mark Price",
        path: "/fapi/v1/premiumIndex",
        params: { symbol },
      },
      {
        key: "openInterest",
        label: "Binance Current Open Interest",
        path: "/fapi/v1/openInterest",
        params: { symbol },
      },
      {
        key: "depth",
        label: "Binance Order Book",
        path: "/fapi/v1/depth",
        params: { symbol, limit: this.orderBookLimit },
      },
      {
        key: "fundingRateHistory",
        label: "Binance Funding Rate History",
        path: "/fapi/v1/fundingRate",
        params: { symbol, limit: 8 },
      },
      {
        key: "klinesSecondary",
        label: `Binance ${this.secondaryInterval} Klines`,
        path: "/fapi/v1/klines",
        params: { symbol, interval: this.secondaryInterval, limit: this.secondaryLimit },
        normalize: normalizeKlines,
      },
      {
        key: "openInterestHistSecondary",
        label: `Binance ${this.secondaryInterval} Open Interest History`,
        path: "/futures/data/openInterestHist",
        params: { symbol, period: this.secondaryInterval, limit: this.secondaryLimit },
      },
      {
        key: "globalLongShortSecondary",
        label: `Binance ${this.secondaryInterval} Global Long/Short`,
        path: "/futures/data/globalLongShortAccountRatio",
        params: { symbol, period: this.secondaryInterval, limit: this.secondaryLimit },
      },
      {
        key: "topAccountSecondary",
        label: `Binance ${this.secondaryInterval} Top Account Long/Short`,
        path: "/futures/data/topLongShortAccountRatio",
        params: { symbol, period: this.secondaryInterval, limit: this.secondaryLimit },
      },
      {
        key: "topPositionSecondary",
        label: `Binance ${this.secondaryInterval} Top Position Long/Short`,
        path: "/futures/data/topLongShortPositionRatio",
        params: { symbol, period: this.secondaryInterval, limit: this.secondaryLimit },
      },
    ];

    const results = await runLimited(endpoints, this.concurrency, async (endpoint) => {
      const result = await this.request(endpoint.path, endpoint.params);
      return {
        key: endpoint.key,
        label: endpoint.label,
        ok: result.ok,
        status: result.status,
        path: result.path,
        params: result.params,
        durationMs: result.durationMs,
        error: result.error,
        body: result.ok && endpoint.normalize ? endpoint.normalize(result.body) : result.body,
      };
    });

    return {
      source: "Binance USD-M Futures",
      ok: results.some((item) => item.ok),
      symbol,
      interval: this.secondaryInterval,
      limit: this.secondaryLimit,
      endpoints: results,
      summary: summarizeBinance(results),
    };
  }

  async request(path, params = {}) {
    const url = new URL(path, BINANCE_FAPI_BASE);
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
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      const body = tryParseJson(text);
      const hasErrorCode =
        body && typeof body === "object" && !Array.isArray(body) && toFiniteNumber(body.code) !== null;
      const ok = response.ok && (!hasErrorCode || toFiniteNumber(body.code) >= 0);

      return {
        ok,
        status: response.status,
        path,
        params,
        durationMs: Date.now() - startedAt,
        body,
        error: ok ? null : buildBinanceError(response.status, body, text),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        path,
        params,
        durationMs: Date.now() - startedAt,
        body: null,
        error: error.name === "AbortError" ? "Request timed out" : error.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toBinanceSymbol(pair, coin, quote) {
  const normalizedPair = String(pair ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedPair.endsWith("USDT") || normalizedPair.endsWith("USDC")) return normalizedPair;
  const normalizedCoin = String(coin ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalizedCoin) return null;
  return `${normalizedCoin}${quote || "USDT"}`;
}

function normalizeKlines(rows) {
  return asArray(rows).map((row) => ({
    time: toFiniteNumber(row[0]),
    open: toFiniteNumber(row[1]),
    high: toFiniteNumber(row[2]),
    low: toFiniteNumber(row[3]),
    close: toFiniteNumber(row[4]),
    volume: toFiniteNumber(row[5]),
    close_time: toFiniteNumber(row[6]),
    quote_volume: toFiniteNumber(row[7]),
    trade_count: toFiniteNumber(row[8]),
    taker_buy_volume: toFiniteNumber(row[9]),
    taker_buy_quote_volume: toFiniteNumber(row[10]),
  }));
}

function summarizeBinance(endpoints) {
  const ticker = getBody(endpoints, "ticker24h");
  const premium = getBody(endpoints, "premiumIndex");
  const openInterest = getBody(endpoints, "openInterest");
  const depth = getBody(endpoints, "depth");
  const klines = asArray(getBody(endpoints, "klinesSecondary"));
  const oiHistory = asArray(getBody(endpoints, "openInterestHistSecondary"));
  const globalRatio = asArray(getBody(endpoints, "globalLongShortSecondary"));
  const topAccount = asArray(getBody(endpoints, "topAccountSecondary"));
  const topPosition = asArray(getBody(endpoints, "topPositionSecondary"));
  const fundingHistory = asArray(getBody(endpoints, "fundingRateHistory"));

  return {
    ticker,
    premium,
    openInterest,
    depth: summarizeDepth(depth),
    secondary: {
      klines: summarizeKlines(klines),
      openInterest: summarizeSeries(oiHistory, "sumOpenInterestValue", "timestamp"),
      globalRatio: latest(globalRatio, "timestamp"),
      topAccount: latest(topAccount, "timestamp"),
      topPosition: latest(topPosition, "timestamp"),
    },
    fundingHistory: fundingHistory.slice(-5),
  };
}

function summarizeDepth(depth) {
  if (!depth || typeof depth !== "object") return null;
  const bids = asArray(depth.bids).map(priceQty);
  const asks = asArray(depth.asks).map(priceQty);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null;
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;
  const bidUsdTop20 = sideNotional(bids.slice(0, 20));
  const askUsdTop20 = sideNotional(asks.slice(0, 20));
  const bidUsdTop50 = sideNotional(bids.slice(0, 50));
  const askUsdTop50 = sideNotional(asks.slice(0, 50));
  const totalTop20 = bidUsdTop20 + askUsdTop20;
  const totalTop50 = bidUsdTop50 + askUsdTop50;

  return {
    bestBid: bestBid?.price ?? null,
    bestAsk: bestAsk?.price ?? null,
    mid,
    spread,
    spreadPercent: mid && spread !== null ? (spread / mid) * 100 : null,
    bidUsdTop20,
    askUsdTop20,
    imbalanceTop20: totalTop20 ? ((bidUsdTop20 - askUsdTop20) / totalTop20) * 100 : null,
    bidUsdTop50,
    askUsdTop50,
    imbalanceTop50: totalTop50 ? ((bidUsdTop50 - askUsdTop50) / totalTop50) * 100 : null,
  };
}

function summarizeKlines(rows) {
  const valid = rows.filter((row) => row && toFiniteNumber(row.close) !== null);
  if (!valid.length) return null;
  const first = valid[0];
  const last = valid.at(-1);
  const high = Math.max(...valid.map((row) => row.high).filter(Number.isFinite));
  const low = Math.min(...valid.map((row) => row.low).filter(Number.isFinite));
  const quoteVolume = valid.reduce((sum, row) => sum + (toFiniteNumber(row.quote_volume) ?? 0), 0);
  const tradeCount = valid.reduce((sum, row) => sum + (toFiniteNumber(row.trade_count) ?? 0), 0);
  const changePercent =
    toFiniteNumber(first.open) && toFiniteNumber(last.close)
      ? ((last.close - first.open) / first.open) * 100
      : null;

  return {
    points: valid.length,
    startTime: first.time,
    endTime: last.close_time ?? last.time,
    open: first.open,
    close: last.close,
    high,
    low,
    changePercent,
    quoteVolume,
    tradeCount,
  };
}

function summarizeSeries(rows, valueKey, timeKey = "time") {
  const valid = rows.filter((row) => row && toFiniteNumber(row[valueKey]) !== null);
  if (!valid.length) return null;
  const first = valid[0];
  const last = valid.at(-1);
  const firstValue = toFiniteNumber(first[valueKey]);
  const lastValue = toFiniteNumber(last[valueKey]);
  return {
    points: valid.length,
    startTime: toFiniteNumber(first[timeKey]),
    endTime: toFiniteNumber(last[timeKey]),
    first: firstValue,
    last: lastValue,
    change: lastValue - firstValue,
    changePercent: firstValue ? ((lastValue - firstValue) / firstValue) * 100 : null,
  };
}

function latest(rows, timeKey = "time") {
  return rows
    .filter((row) => row && typeof row === "object")
    .slice()
    .sort((a, b) => (toFiniteNumber(a[timeKey]) ?? 0) - (toFiniteNumber(b[timeKey]) ?? 0))
    .at(-1) ?? null;
}

function priceQty(row) {
  return {
    price: toFiniteNumber(row?.[0]) ?? 0,
    quantity: toFiniteNumber(row?.[1]) ?? 0,
  };
}

function sideNotional(rows) {
  return rows.reduce((sum, row) => sum + row.price * row.quantity, 0);
}

function getBody(endpoints, key) {
  return endpoints.find((endpoint) => endpoint.key === key && endpoint.ok)?.body ?? null;
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildBinanceError(status, body, text) {
  if (body && typeof body === "object") {
    return body.msg || body.message || body.error || `Binance returned HTTP ${status}`;
  }
  return text ? String(text).slice(0, 500) : `Binance returned HTTP ${status}`;
}
