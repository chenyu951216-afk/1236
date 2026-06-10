import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBoolean, parseInteger, splitCsv } from "./util.js";

export function loadDotEnv(path = ".env") {
  const envPath = resolve(process.cwd(), path);
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getConfig() {
  loadDotEnv();

  const missing = ["DISCORD_BOT_TOKEN", "COINGLASS_API_KEY"].filter(
    (key) => !process.env[key],
  );

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    discordToken: process.env.DISCORD_BOT_TOKEN,
    coinglassApiKey: process.env.COINGLASS_API_KEY,
    allowedUserIds: splitCsv(process.env.ALLOWED_USER_IDS),
    allowedChannelIds: splitCsv(process.env.ALLOWED_CHANNEL_IDS),
    allowBareSymbol: parseBoolean(process.env.ALLOW_BARE_SYMBOL, true),
    commandPrefixes: splitCsv(process.env.COMMAND_PREFIXES || "!cg,cg,/cg"),
    defaultExchange: process.env.DEFAULT_EXCHANGE || "Binance",
    defaultQuote: (process.env.DEFAULT_QUOTE || "USDT").toUpperCase(),
    defaultInterval: process.env.DEFAULT_INTERVAL || "4h",
    historyLimit: parseInteger(process.env.HISTORY_LIMIT, 60, { min: 5, max: 1000 }),
    aggregatedExchanges: splitCsv(process.env.AGGREGATED_EXCHANGES || "Binance,OKX,Bybit"),
    liquidationRange: process.env.LIQUIDATION_RANGE || "24h",
    enableExchangeSupplement: parseBoolean(process.env.ENABLE_EXCHANGE_SUPPLEMENT, true),
    secondaryInterval: process.env.SECONDARY_INTERVAL || "15m",
    secondaryLimit: parseInteger(process.env.SECONDARY_LIMIT, 96, { min: 20, max: 500 }),
    orderBookLimit: parseInteger(process.env.ORDER_BOOK_LIMIT, 100, { min: 20, max: 1000 }),
    coinglassConcurrency: parseInteger(process.env.COINGLASS_CONCURRENCY, 3, { min: 1, max: 8 }),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 20_000, {
      min: 3_000,
      max: 120_000,
    }),
    discordMaxAttachmentBytes: parseInteger(
      process.env.DISCORD_MAX_ATTACHMENT_BYTES,
      7_500_000,
      { min: 1_000_000, max: 25_000_000 },
    ),
  };
}
