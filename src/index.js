import { CoinGlassClient, parseRequestOptions } from "./coinglass.js";
import { getConfig } from "./config.js";
import { DiscordBot } from "./discord.js";
import { ExchangeSupplementClient } from "./exchangeSupplement.js";
import { buildReport } from "./report.js";

const HELP_TEXT = [
  "用法:",
  "`btc` 或 `btC` - 直接查合約資料",
  "`!cg eth` - 指令查詢",
  "`!cg btc --exchange Bybit --interval 4h --limit 80 --range 24h`",
  "可用 interval: 1m,3m,5m,15m,30m,1h,4h,6h,8h,12h,1d,1w；低階 CoinGlass 方案建議用 4h 以上。",
].join("\n");

async function main() {
  const config = getConfig();
  const coinglass = new CoinGlassClient(config);
  const exchangeSupplement = new ExchangeSupplementClient(config);
  const activeJobs = new Set();

  const bot = new DiscordBot(config, {
    async onMessage(message, discord) {
      if (message.author?.bot) return;
      if (!isAllowed(message, config)) return;

      const parsed = parseDiscordRequest(message.content, config, discord.user?.id);
      if (!parsed) return;

      const reference = {
        message_id: message.id,
        channel_id: message.channel_id,
        guild_id: message.guild_id,
        fail_if_not_exists: false,
      };

      if (parsed.help) {
        await discord.sendText(message.channel_id, HELP_TEXT, reference);
        return;
      }

      const normalized = await coinglass.normalizeSymbol(parsed.symbol, {
        exchange: parsed.options.exchange,
        requireSupported: true,
      });

      if (!normalized.ok) {
        if (parsed.explicit) {
          await discord.sendText(
            message.channel_id,
            `我看不懂或 CoinGlass futures 不支援這個代號: \`${parsed.symbol}\`。可以試試 \`btc\`、\`eth\`、\`BTCUSDT\`。`,
            reference,
          );
        }
        return;
      }

      const jobKey = `${message.channel_id}:${message.author.id}:${normalized.coin}`;
      if (activeJobs.has(jobKey)) {
        await discord.sendText(message.channel_id, `${normalized.coin} 還在抓上一筆資料，等它回來再丟一次。`, reference);
        return;
      }

      activeJobs.add(jobKey);
      try {
        await discord.sendTyping(message.channel_id);
        const exchange = parsed.options.exchange ?? normalized.exchange;
        const bundle = await coinglass.buildFuturesBundle({
          coin: normalized.coin,
          pair: normalized.pair,
          exchange,
          interval: parsed.options.interval,
          limit: parsed.options.limit,
          liquidationRange: parsed.options.liquidationRange,
        });

        bundle.supplement = await exchangeSupplement.build({
          coin: normalized.coin,
          pair: normalized.pair,
          exchange,
        });

        const report = buildReport(bundle);
        for (let index = 0; index < report.messages.length; index += 1) {
          await discord.sendText(message.channel_id, report.messages[index], index === 0 ? reference : undefined);
        }

        if (report.files.length) {
          await discord.sendMessageWithFiles(message.channel_id, {
            content: `${bundle.meta.coin} 圖表：上半部 ${bundle.meta.interval}，下半部 ${bundle.supplement?.interval ?? "15m"}。`,
            reference: undefined,
            files: report.files,
          });
        }
      } catch (error) {
        console.error(error);
        await discord.sendText(
          message.channel_id,
          `抓資料時失敗了: ${error.message}`,
          reference,
        );
      } finally {
        activeJobs.delete(jobKey);
      }
    },
  });

  process.on("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });

  await bot.start();
}

function isAllowed(message, config) {
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(message.author?.id)) {
    return false;
  }
  if (config.allowedChannelIds.length && !config.allowedChannelIds.includes(message.channel_id)) {
    return false;
  }
  return true;
}

function parseDiscordRequest(content, config, botUserId) {
  let text = String(content ?? "").trim();
  if (!text) return null;

  if (botUserId) {
    text = text.replace(new RegExp(`^<@!?${botUserId}>\\s*`), "").trim();
  }

  const prefix = config.commandPrefixes.find((item) => {
    const lowerText = text.toLowerCase();
    const lowerPrefix = item.toLowerCase();
    return lowerText === lowerPrefix || lowerText.startsWith(`${lowerPrefix} `);
  });

  const explicit = Boolean(prefix);
  if (prefix) {
    text = text.slice(prefix.length).trim();
  } else if (!config.allowBareSymbol) {
    return null;
  }

  if (!text) return explicit ? { help: true } : null;

  const tokens = text.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (explicit && ["help", "?", "h"].includes(first)) return { help: true };

  if (!explicit && tokens.length > 1) return null;
  const symbol = tokens[0];
  if (!/^[#$]?[a-z0-9_/-]{2,24}$/i.test(symbol)) return null;

  return {
    explicit,
    symbol,
    options: parseRequestOptions(tokens.slice(1), config),
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
