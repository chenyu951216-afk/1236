import { gzipSync } from "node:zlib";
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
  truncateDiscordContent,
} from "./util.js";

export function buildReport(bundle, { maxAttachmentBytes }) {
  const summary = extractSummary(bundle);
  const timestamp = timestampForFile(new Date(bundle.meta.requestedAt));
  const baseName = safeFilePart(`${bundle.meta.coin}_${bundle.meta.exchange}_${bundle.meta.pair}_${timestamp}`);
  const rawJson = Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
  const textReport = Buffer.from(buildTextReport(bundle, summary), "utf8");
  const csv = Buffer.from(buildCsv(bundle), "utf8");
  const chart = createMarketChart(bundle);

  const files = [
    prepareAttachment({
      name: `${baseName}_raw.json`,
      data: rawJson,
      contentType: "application/json",
      maxAttachmentBytes,
    }),
    {
      name: `${baseName}_summary.csv`,
      data: csv,
      contentType: "text/csv",
    },
    {
      name: `${baseName}_report.txt`,
      data: textReport,
      contentType: "text/plain",
    },
  ].filter(Boolean);

  if (chart) {
    files.push({
      name: `${baseName}_chart.png`,
      data: chart,
      contentType: "image/png",
    });
  }

  return {
    message: buildDiscordMessage(bundle, summary),
    files,
  };
}

function prepareAttachment({ name, data, contentType, maxAttachmentBytes }) {
  if (data.length <= maxAttachmentBytes) return { name, data, contentType };

  const gzipped = gzipSync(data);
  const gzName = `${name}.gz`;
  if (gzipped.length <= maxAttachmentBytes) {
    return {
      name: gzName,
      data: gzipped,
      contentType: "application/gzip",
      description: "Raw JSON was compressed because it exceeded the configured Discord attachment size.",
    };
  }

  return {
    name: name.replace(/\.json$/i, "_too_large.txt"),
    data: Buffer.from(
      `Raw JSON was ${data.length} bytes and still ${gzipped.length} bytes after gzip, above the configured limit ${maxAttachmentBytes}. Use the CSV/TXT report or raise DISCORD_MAX_ATTACHMENT_BYTES if your Discord server supports larger files.\n`,
      "utf8",
    ),
    contentType: "text/plain",
  };
}

function extractSummary(bundle) {
  const pairs = getRows(bundle, "pairsMarkets");
  const oiRows = getRows(bundle, "openInterestExchangeList");
  const liqRows = getRows(bundle, "liquidationExchangeList");
  const fundingRows = getRows(bundle, "fundingRateExchangeList");
  const priceLatest = latestByTime(getRows(bundle, "priceHistory"));
  const oiLatest = latestByTime(getRows(bundle, "openInterestAggregatedHistory"));
  const liqLatest = latestByTime(getRows(bundle, "liquidationAggregatedHistory"));
  const takerLatest = latestByTime(getRows(bundle, "takerBuySellHistory"));
  const globalRatioLatest = latestByTime(getRows(bundle, "globalAccountRatio"));
  const topAccountLatest = latestByTime(getRows(bundle, "topAccountRatio"));
  const topPositionLatest = latestByTime(getRows(bundle, "topPositionRatio"));
  const rsi = getRows(bundle, "rsiList")[0] ?? null;
  const macd = getRows(bundle, "macdList")[0] ?? null;
  const ema = getRows(bundle, "emaList")[0] ?? null;
  const ma = getRows(bundle, "maList")[0] ?? null;

  const selectedPair = selectPairMarket(pairs, bundle.meta.exchange);
  const oiAll = findExchangeRow(oiRows, "All") ?? oiRows[0] ?? null;
  const liqAll = findExchangeRow(liqRows, "All") ?? liqRows[0] ?? null;
  const funding = selectFundingRow(fundingRows, bundle.meta.exchange);
  const successCount = bundle.endpoints.filter((endpoint) => endpoint.ok).length;
  const failureCount = bundle.endpoints.length - successCount;

  return {
    selectedPair,
    oiAll,
    liqAll,
    funding,
    priceLatest,
    oiLatest,
    liqLatest,
    takerLatest,
    globalRatioLatest,
    topAccountLatest,
    topPositionLatest,
    rsi,
    macd,
    ema,
    ma,
    successCount,
    failureCount,
  };
}

function buildDiscordMessage(bundle, summary) {
  const pair = summary.selectedPair;
  const price = pair?.current_price ?? summary.priceLatest?.close;
  const priceChange = pair?.price_change_percent_24h;
  const oiUsd = summary.oiAll?.open_interest_usd ?? pair?.open_interest_usd ?? summary.oiLatest?.close;
  const oiChange = summary.oiAll?.open_interest_change_percent_24h ?? pair?.open_interest_change_percent_24h;
  const liq = summary.liqAll;
  const funding = summary.funding;
  const ratio = summary.globalRatioLatest;

  const lines = [
    `**${bundle.meta.coin} 合約資料包**`,
    `來源: ${bundle.meta.exchange} / ${bundle.meta.pair} / ${bundle.meta.interval} / ${formatTime(Date.parse(bundle.meta.requestedAt))}`,
    `現價: ${formatUsd(price)} | 24h: ${formatPercent(priceChange)}`,
    `OI: ${formatUsd(oiUsd)} | 24h: ${formatPercent(oiChange)}`,
    `Funding: ${funding ? `${funding.exchange} ${formatFundingRate(funding.funding_rate)}` : "n/a"}`,
    `清算(${bundle.meta.liquidationRange}): ${formatUsd(liq?.liquidation_usd)} | Long ${formatUsd(liq?.long_liquidation_usd)} / Short ${formatUsd(liq?.short_liquidation_usd)}`,
    `多空帳戶比: ${formatNumber(ratio?.global_account_long_short_ratio)} | 多 ${formatPercent(ratio?.global_account_long_percent)} / 空 ${formatPercent(ratio?.global_account_short_percent)}`,
    `API: 成功 ${summary.successCount}/${bundle.endpoints.length}${summary.failureCount ? `，${summary.failureCount} 個端點無權限或失敗，詳見 report.txt/raw.json` : ""}`,
    "附件: raw JSON、CSV、TXT、PNG 圖表，可在手機端下載或轉傳。",
  ];

  return truncateDiscordContent(lines.join("\n"));
}

function buildTextReport(bundle, summary) {
  const failures = bundle.endpoints.filter((endpoint) => !endpoint.ok);
  const fundingList = flattenFunding(getRows(bundle, "fundingRateExchangeList"));

  const lines = [
    `${bundle.meta.coin} futures report`,
    `requested_at: ${bundle.meta.requestedAt}`,
    `exchange: ${bundle.meta.exchange}`,
    `pair: ${bundle.meta.pair}`,
    `interval: ${bundle.meta.interval}`,
    `aggregated_exchanges: ${bundle.meta.aggregatedExchanges.join(",")}`,
    "",
    "[current]",
    `price: ${formatUsd(summary.selectedPair?.current_price ?? summary.priceLatest?.close)}`,
    `24h_price_change: ${formatPercent(summary.selectedPair?.price_change_percent_24h)}`,
    `volume_usd_24h: ${formatUsd(summary.selectedPair?.volume_usd)}`,
    `open_interest_usd: ${formatUsd(summary.oiAll?.open_interest_usd ?? summary.selectedPair?.open_interest_usd)}`,
    `open_interest_change_24h: ${formatPercent(summary.oiAll?.open_interest_change_percent_24h ?? summary.selectedPair?.open_interest_change_percent_24h)}`,
    `funding_rate: ${summary.funding ? `${summary.funding.exchange} ${formatFundingRate(summary.funding.funding_rate)}` : "n/a"}`,
    `liquidation_total: ${formatUsd(summary.liqAll?.liquidation_usd)}`,
    `liquidation_long: ${formatUsd(summary.liqAll?.long_liquidation_usd)}`,
    `liquidation_short: ${formatUsd(summary.liqAll?.short_liquidation_usd)}`,
    "",
    "[ratios]",
    `global_account_ratio: ${formatNumber(summary.globalRatioLatest?.global_account_long_short_ratio)}`,
    `top_account_ratio: ${formatNumber(summary.topAccountLatest?.top_account_long_short_ratio)}`,
    `top_position_ratio: ${formatNumber(summary.topPositionLatest?.top_position_long_short_ratio)}`,
    "",
    "[technical]",
    `rsi_1h: ${formatNumber(summary.rsi?.rsi_1h)}`,
    `rsi_4h: ${formatNumber(summary.rsi?.rsi_4h)}`,
    `macd_1h: ${formatNumber(summary.macd?.macd_1h)}`,
    `ema_1h: ${formatNumber(summary.ema?.ema_1h)}`,
    `ma_1h: ${formatNumber(summary.ma?.ma_1h)}`,
    "",
    "[funding_by_exchange]",
    ...fundingList
      .slice(0, 12)
      .map((item) => `${item.exchange}: ${formatFundingRate(item.funding_rate)} next=${formatTime(item.next_funding_time)}`),
    "",
    "[endpoint_status]",
    ...bundle.endpoints.map((endpoint) =>
      `${endpoint.ok ? "OK" : "FAIL"} ${endpoint.key} ${endpoint.status} ${endpoint.durationMs}ms ${endpoint.error ?? ""}`.trim(),
    ),
  ];

  if (failures.length) {
    lines.push("", "[failures]");
    for (const failure of failures) {
      lines.push(`${failure.label}: ${failure.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildCsv(bundle) {
  const rows = [["category", "source", "time", "exchange", "metric", "value"]];

  for (const endpoint of bundle.endpoints) {
    const data = responseData(endpoint.body);
    if (!endpoint.ok) {
      rows.push([endpoint.key, endpoint.path, "", "", "error", endpoint.error ?? "failed"]);
      continue;
    }

    for (const row of asArray(data)) {
      if (!row || typeof row !== "object") {
        rows.push([endpoint.key, endpoint.path, "", "", "value", row ?? ""]);
        continue;
      }

      for (const [metric, value] of Object.entries(row)) {
        if (value && typeof value === "object") continue;
        rows.push([
          endpoint.key,
          endpoint.path,
          row.time ? new Date(toFiniteNumber(row.time)).toISOString() : "",
          row.exchange ?? row.exchange_name ?? "",
          metric,
          value ?? "",
        ]);
      }
    }
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
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
