export function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

export function parseInteger(value, fallback, { min, max } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (Number.isFinite(min) && parsed < min) return min;
  if (Number.isFinite(max) && parsed > max) return max;
  return parsed;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

export function responseData(body) {
  if (!body || typeof body !== "object") return body;
  return body.data ?? body.result ?? body;
}

export function latestByTime(rows) {
  const items = asArray(rows).filter((row) => row && typeof row === "object");
  if (!items.length) return null;
  return items
    .slice()
    .sort((a, b) => (toFiniteNumber(a.time) ?? 0) - (toFiniteNumber(b.time) ?? 0))
    .at(-1);
}

export function formatUsd(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(number / 1_000).toFixed(2)}K`;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function formatNumber(value, maximumFractionDigits = 4) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  return number.toLocaleString("en-US", { maximumFractionDigits });
}

export function formatPercent(value, maximumFractionDigits = 4) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  return `${number.toLocaleString("en-US", { maximumFractionDigits })}%`;
}

export function formatFundingRate(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  return `${number.toLocaleString("en-US", { maximumFractionDigits: 6 })}%`;
}

export function formatTime(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "n/a";
  const date = new Date(number);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function safeFilePart(value) {
  return String(value ?? "file")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "file";
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function runLimited(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker()),
  );

  return results;
}

export function truncateDiscordContent(content, limit = 1900) {
  const text = String(content ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 16).trimEnd()}\n...(truncated)`;
}
