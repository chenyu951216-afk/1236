import { createMarketChart } from "./chart.js";
import {
  asArray,
  formatFundingRate,
  formatNumber,
  formatPercent,
  formatTime,
  formatUsd,
  latestByTime,
  responseData,
  safeFilePart,
  timestampForFile,
  toFiniteNumber,
} from "./util.js";

const DISCORD_LIMIT = 1850;

export function buildReport(bundle) {
  const summary = extractSummary(bundle);
  const timestamp = timestampForFile(new Date(bundle.meta.requestedAt));
  const baseName = safeFilePart(`${bundle.meta.coin}_${bundle.meta.exchange}_${bundle.meta.pair}_${timestamp}`);
  const chart = createMarketChart(bundle);

  const sections = [
    buildSnapshotSection(bundle, summary),
    buildCoinGlassSection(bundle, summary),
    buildExchangeSupplementSection(bundle, summary),
    buildLevelsSection(bundle, summary),
    buildStatusSection(bundle, summary),
  ].filter(Boolean);

  const messages = sections.flatMap((section) => splitDiscordMessage(section));
  const files = chart
    ? [
        {
          name: `${baseName}_chart.png`,
          data: chart,
          contentType: "image/png",
        },
      ]
    : [];

  return { messages, files };
}

function extractSummary(bundle) {
  const pairs = getRows(bundle, "pairsMarkets");
  const oiRows = getRows(bundle, "openInterestExchangeList");
  const liqRows = getRows(bundle, "liquidationExchangeList");
  const fundingRows = getRows(bundle, "fundingRateExchangeList");
  const priceRows = getRows(bundle, "priceHistory");
  const oiHistoryRows = getRows(bundle, "openInterestAggregatedHistory");
  const liquidationHistoryRows = getRows(bundle, "liquidationAggregatedHistory");
  const takerRows = getRows(bundle, "takerBuySellHistory");
  const globalRatioRows = getRows(bundle, "globalAccountRatio");
  const topAccountRows = getRows(bundle, "topAccountRatio");
  const topPositionRows = getRows(bundle, "topPositionRatio");

  const selectedPair = selectPairMarket(pairs, bundle.meta.exchange);
  const oiAll = findExchangeRow(oiRows, "All") ?? oiRows[0] ?? null;
  const liqAll = findExchangeRow(liqRows, "All") ?? liqRows[0] ?? null;
  const funding = selectFundingRow(fundingRows, bundle.meta.exchange);
  const priceLatest = latestByTime(priceRows);
  const priceRange = summarizeOhlcRange(priceRows);
  const oiLatest = latestByTime(oiHistoryRows);
  const liqLatest = latestByTime(liquidationHistoryRows);
  const takerLatest = latestByTime(takerRows);
  const globalRatioLatest = latestByTime(globalRatioRows);
  const topAccountLatest = latestByTime(topAccountRows);
  const topPositionLatest = latestByTime(topPositionRows);
  const successCount = bundle.endpoints.filter((endpoint) => endpoint.ok).length;
  const failureCount = bundle.endpoints.length - successCount;

  return {
    selectedPair,
    oiRows,
    fundingRows,
    liqRows,
    oiAll,
    liqAll,
    funding,
    priceLatest,
    priceRange,
    oiLatest,
    liqLatest,
    takerLatest,
    globalRatioLatest,
    topAccountLatest,
    topPositionLatest,
    successCount,
    failureCount,
    supplement: bundle.supplement?.summary ?? null,
  };
}

function buildSnapshotSection(bundle, summary) {
  const s = summary.supplement;
  const ticker = s?.ticker;
  const premium = s?.premium;
  const pair = summary.selectedPair;
  const price = ticker?.lastPrice ?? premium?.markPrice ?? pair?.current_price ?? summary.priceLatest?.close;
  const mark = premium?.markPrice;
  const index = premium?.indexPrice;
  const basisPercent = calcPercentDiff(mark, index);
  const priceChange = ticker?.priceChangePercent ?? pair?.price_change_percent_24h;
  const high24h = ticker?.highPrice;
  const low24h = ticker?.lowPrice;
  const volume24h = ticker?.quoteVolume ?? pair?.volume_usd;
  const tradeCount = ticker?.count;
  const oiUsd = summary.oiAll?.open_interest_usd ?? pair?.open_interest_usd ?? summary.oiLatest?.close;
  const oiChange = summary.oiAll?.open_interest_change_percent_24h ?? pair?.open_interest_change_percent_24h;
  const funding = summary.funding;

  return [
    `**${bundle.meta.coin} 合約整理報告 | ${bundle.meta.exchange} ${bundle.meta.pair}**`,
    `時間: ${formatTime(Date.parse(bundle.meta.requestedAt))} | 主週期: ${bundle.meta.interval} | 補強週期: ${bundle.supplement?.interval ?? "15m"}`,
    "",
    "**現況快照**",
    `現價: ${formatUsd(price)} | 24h: ${formatPercent(priceChange)} | 24h高低: ${formatUsd(high24h)} / ${formatUsd(low24h)}`,
    `Mark/Index: ${formatUsd(mark)} / ${formatUsd(index)} | Basis: ${formatPercent(basisPercent)}`,
    `24h量: ${formatUsd(volume24h)} | 成交筆數: ${formatNumber(tradeCount, 0)}`,
    `OI: ${formatUsd(oiUsd)} | OI 24h: ${formatPercent(oiChange)} | Binance OI張數: ${formatNumber(s?.openInterest?.openInterest, 2)}`,
    `Funding: CoinGlass ${funding ? `${funding.exchange} ${formatFundingRate(funding.funding_rate)}` : "n/a"} | Binance ${formatDecimalPercent(premium?.lastFundingRate)} | 下次: ${formatTime(premium?.nextFundingTime)}`,
    `清算(${bundle.meta.liquidationRange}): ${formatUsd(summary.liqAll?.liquidation_usd)} | Long ${formatUsd(summary.liqAll?.long_liquidation_usd)} / Short ${formatUsd(summary.liqAll?.short_liquidation_usd)}`,
  ].join("\n");
}

function buildCoinGlassSection(bundle, summary) {
  const taker = summary.takerLatest;
  const buy = taker?.aggregated_buy_volume_usd;
  const sell = taker?.aggregated_sell_volume_usd;
  const buySellRatio = ratio(buy, sell);
  const oiTop = summary.oiRows
    .filter((row) => String(row.exchange ?? "").toLowerCase() !== "all")
    .slice()
    .sort((a, b) => (toFiniteNumber(b.open_interest_usd) ?? 0) - (toFiniteNumber(a.open_interest_usd) ?? 0))
    .slice(0, 5);
  const fundingList = flattenFunding(summary.fundingRows)
    .filter((item) => toFiniteNumber(item.funding_rate) !== null)
    .slice()
    .sort((a, b) => Math.abs(toFiniteNumber(b.funding_rate)) - Math.abs(toFiniteNumber(a.funding_rate)))
    .slice(0, 6);

  return [
    `**CoinGlass 跨交易所衍生品 (${bundle.meta.interval})**`,
    `OI排行: ${oiTop.map((row) => `${row.exchange} ${formatUsd(row.open_interest_usd)}(${formatPercent(row.open_interest_change_percent_24h)})`).join(" | ") || "n/a"}`,
    `Taker買/賣: ${formatUsd(buy)} / ${formatUsd(sell)} | 買賣比: ${formatNumber(buySellRatio, 3)}`,
    `多空帳戶比: Global ${formatNumber(summary.globalRatioLatest?.global_account_long_short_ratio, 3)} | Top帳戶 ${formatNumber(summary.topAccountLatest?.top_account_long_short_ratio, 3)} | Top倉位 ${formatNumber(summary.topPositionLatest?.top_position_long_short_ratio, 3)}`,
    `最新歷史OI: ${formatUsd(summary.oiLatest?.close)} | 最新歷史清算: Long ${formatUsd(summary.liqLatest?.aggregated_long_liquidation_usd)} / Short ${formatUsd(summary.liqLatest?.aggregated_short_liquidation_usd)}`,
    `Funding較明顯: ${fundingList.map((item) => `${item.exchange} ${formatFundingRate(item.funding_rate)}`).join(" | ") || "n/a"}`,
  ].join("\n");
}

function buildExchangeSupplementSection(bundle, summary) {
  const supplement = bundle.supplement;
  const s = summary.supplement;
  if (!supplement || !s) return null;

  const k = s.secondary?.klines;
  const oi = s.secondary?.openInterest;
  const global = s.secondary?.globalRatio;
  const topAccount = s.secondary?.topAccount;
  const topPosition = s.secondary?.topPosition;
  const depth = s.depth;

  return [
    `**${supplement.source} 補強 (${supplement.interval})**`,
    `15m區間: ${formatTime(k?.startTime)} -> ${formatTime(k?.endTime)} | 點數: ${formatNumber(k?.points, 0)}`,
    `15m價格: 開 ${formatUsd(k?.open)} / 收 ${formatUsd(k?.close)} | 漲跌 ${formatPercent(k?.changePercent)} | 高低 ${formatUsd(k?.high)} / ${formatUsd(k?.low)}`,
    `15m量: ${formatUsd(k?.quoteVolume)} | 交易筆數: ${formatNumber(k?.tradeCount, 0)}`,
    `15m OI: ${formatUsd(oi?.last)} | 區間變化 ${formatUsd(oi?.change)} (${formatPercent(oi?.changePercent)})`,
    `15m多空: Global ${formatNumber(global?.longShortRatio, 3)} | Top帳戶 ${formatNumber(topAccount?.longShortRatio, 3)} | Top倉位 ${formatNumber(topPosition?.longShortRatio, 3)}`,
    `Orderbook: bid/ask ${formatUsd(depth?.bestBid)} / ${formatUsd(depth?.bestAsk)} | spread ${formatPercent(depth?.spreadPercent, 5)}`,
    `深度Top20: Bid ${formatUsd(depth?.bidUsdTop20)} / Ask ${formatUsd(depth?.askUsdTop20)} | 不平衡 ${formatPercent(depth?.imbalanceTop20)}`,
    `深度Top50: Bid ${formatUsd(depth?.bidUsdTop50)} / Ask ${formatUsd(depth?.askUsdTop50)} | 不平衡 ${formatPercent(depth?.imbalanceTop50)}`,
  ].join("\n");
}

function buildLevelsSection(bundle, summary) {
  const s = summary.supplement;
  const k = s?.secondary?.klines;
  const priceRange = summary.priceRange;
  const price = s?.ticker?.lastPrice ?? summary.selectedPair?.current_price ?? summary.priceLatest?.close;
  const depth = s?.depth;
  const lines = [
    "**給 GPT / 交易計畫用的數據點位**",
    `目前價格: ${formatUsd(price)} | Mark: ${formatUsd(s?.premium?.markPrice)} | Index: ${formatUsd(s?.premium?.indexPrice)}`,
    `15m區間高/低: ${formatUsd(k?.high)} / ${formatUsd(k?.low)} | 15m收盤: ${formatUsd(k?.close)}`,
    `${bundle.meta.interval}區間高/低: ${formatUsd(priceRange.high)} / ${formatUsd(priceRange.low)} | ${bundle.meta.interval}最新收盤: ${formatUsd(summary.priceLatest?.close)}`,
    `Orderbook最近 bid/ask: ${formatUsd(depth?.bestBid)} / ${formatUsd(depth?.bestAsk)}`,
    "",
    "止損設計提示:",
    "- 做多止損優先看 15m 區間低點、4h 區間低點、跌破後 OI 是否同步退場。",
    "- 做空止損優先看 15m 區間高點、4h 區間高點、突破後 OI 是否同步增加。",
    "- 如果止損距離過大導致單筆風險超過本金 1%-2%，這筆交易應降槓桿、降倉位或不交易。",
  ];

  return lines.join("\n");
}

function buildStatusSection(bundle, summary) {
  const failures = bundle.endpoints.filter((endpoint) => !endpoint.ok);
  const supplementFailures = asArray(bundle.supplement?.endpoints).filter((endpoint) => !endpoint.ok);
  const notes = interpretMarket(summary);

  return [
    "**資料解讀與狀態**",
    ...notes.map((note) => `- ${note}`),
    `CoinGlass API: 成功 ${summary.successCount}/${bundle.endpoints.length}${failures.length ? ` | 失敗: ${failures.map((item) => item.key).join(", ")}` : ""}`,
    `交易所補強: ${bundle.supplement?.ok ? "可用" : "不可用"}${supplementFailures.length ? ` | 失敗: ${supplementFailures.map((item) => item.key).join(", ")}` : ""}`,
    "注意: 這是數據整理，不是自動下單建議。讓 GPT 給方向時，請要求它在訊號衝突時回答觀望。",
  ].join("\n");
}

function interpretMarket(summary) {
  const notes = [];
  const priceChange = toFiniteNumber(summary.supplement?.ticker?.priceChangePercent ?? summary.selectedPair?.price_change_percent_24h);
  const oiChange = toFiniteNumber(summary.oiAll?.open_interest_change_percent_24h ?? summary.selectedPair?.open_interest_change_percent_24h);
  const funding = toFiniteNumber(summary.supplement?.premium?.lastFundingRate);
  const topPosition = toFiniteNumber(summary.topPositionLatest?.top_position_long_short_ratio);
  const globalRatio = toFiniteNumber(summary.globalRatioLatest?.global_account_long_short_ratio);
  const imbalance = toFiniteNumber(summary.supplement?.depth?.imbalanceTop20);

  if (priceChange !== null && oiChange !== null) {
    if (priceChange > 0 && oiChange > 0) notes.push("價格與 OI 同升，代表新倉位跟著上漲進場，動能偏強但追價風險也升高。");
    if (priceChange < 0 && oiChange > 0) notes.push("價格下跌但 OI 增加，可能是空方加倉或多方被動承接，需防延續下殺。");
    if (priceChange > 0 && oiChange < 0) notes.push("價格上漲但 OI 下降，可能偏空回補或減倉反彈，追多需要更保守。");
  }

  if (funding !== null) {
    if (funding > 0.0005) notes.push("Binance funding 明顯為正，多方持倉成本提高，若價格轉弱需防多殺多。");
    else if (funding < -0.0005) notes.push("Binance funding 明顯為負，空方持倉成本提高，若價格轉強需防空殺空。");
  }

  if (globalRatio !== null && topPosition !== null) {
    if (topPosition > globalRatio) notes.push("Top倉位多空比高於一般帳戶，多方部位集中度較高。");
    if (topPosition < globalRatio) notes.push("Top倉位多空比低於一般帳戶，主力部位比散戶更保守或偏空。");
  }

  if (imbalance !== null) {
    if (imbalance > 15) notes.push("Orderbook Top20 bid 偏厚，短線下方承接較明顯，但仍可能被掃流動性。");
    if (imbalance < -15) notes.push("Orderbook Top20 ask 偏厚，短線上方賣壓較明顯。");
  }

  if (!notes.length) notes.push("主要訊號沒有明顯單邊傾向，較適合等待突破或跌破後再判斷。");
  return notes;
}

function splitDiscordMessage(text) {
  if (text.length <= DISCORD_LIMIT) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).trim().length > DISCORD_LIMIT) {
      if (current.trim()) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function getRows(bundle, key) {
  const endpoint = bundle.endpoints.find((item) => item.key === key);
  return asArray(responseData(endpoint?.body)).filter((row) => row && typeof row === "object");
}

function selectPairMarket(rows, exchange) {
  const byExchange = rows.find(
    (row) => String(row.exchange_name ?? row.exchange ?? "").toLowerCase() === exchange.toLowerCase(),
  );
  if (byExchange) return byExchange;
  return rows
    .slice()
    .sort((a, b) => (toFiniteNumber(b.open_interest_usd) ?? 0) - (toFiniteNumber(a.open_interest_usd) ?? 0))[0] ?? null;
}

function findExchangeRow(rows, exchange) {
  return rows.find((row) => String(row.exchange ?? row.exchange_name ?? "").toLowerCase() === exchange.toLowerCase());
}

function selectFundingRow(rows, exchange) {
  const flattened = flattenFunding(rows);
  return (
    flattened.find((row) => String(row.exchange ?? "").toLowerCase() === exchange.toLowerCase()) ??
    flattened
      .slice()
      .sort((a, b) => Math.abs(toFiniteNumber(b.funding_rate) ?? 0) - Math.abs(toFiniteNumber(a.funding_rate) ?? 0))[0] ??
    null
  );
}

function flattenFunding(rows) {
  const result = [];
  for (const row of rows) {
    for (const item of asArray(row.stablecoin_margin_list)) {
      result.push({ ...item, margin: "stablecoin" });
    }
    for (const item of asArray(row.token_margin_list)) {
      result.push({ ...item, margin: "token" });
    }
  }
  return result;
}

function summarizeOhlcRange(rows) {
  const highs = rows.map((row) => toFiniteNumber(row.high)).filter((value) => value !== null);
  const lows = rows.map((row) => toFiniteNumber(row.low)).filter((value) => value !== null);
  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
  };
}

function ratio(a, b) {
  const left = toFiniteNumber(a);
  const right = toFiniteNumber(b);
  if (left === null || right === null || right === 0) return null;
  return left / right;
}

function calcPercentDiff(a, b) {
  const left = toFiniteNumber(a);
  const right = toFiniteNumber(b);
  if (left === null || right === null || right === 0) return null;
  return ((left - right) / right) * 100;
}

function formatDecimalPercent(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  return `${(number * 100).toLocaleString("en-US", { maximumFractionDigits: 6 })}%`;
}
