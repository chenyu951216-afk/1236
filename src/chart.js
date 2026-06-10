import { deflateSync } from "node:zlib";
import { asArray, responseData, toFiniteNumber } from "./util.js";

const WIDTH = 1200;
const HEIGHT = 820;

export function createMarketChart(bundle) {
  const primaryPriceRows = getEndpointRows(bundle, "priceHistory");
  const primaryOiRows = getEndpointRows(bundle, "openInterestAggregatedHistory");
  const primaryLiqRows = getEndpointRows(bundle, "liquidationAggregatedHistory");
  const secondaryPriceRows = getSupplementRows(bundle, "klinesSecondary");
  const secondaryOiRows = getSupplementRows(bundle, "openInterestHistSecondary");

  const primary = {
    title: `${bundle.meta.coin} ${bundle.meta.interval.toUpperCase()} COINGLASS`,
    price: primaryPriceRows.map((row) => point(row.time, row.close)).filter(Boolean),
    oi: primaryOiRows.map((row) => point(row.time, row.close)).filter(Boolean),
    longLiq: primaryLiqRows.map((row) => point(row.time, row.aggregated_long_liquidation_usd)).filter(Boolean),
    shortLiq: primaryLiqRows.map((row) => point(row.time, row.aggregated_short_liquidation_usd)).filter(Boolean),
  };
  const secondary = {
    title: `${bundle.meta.coin} ${(bundle.supplement?.interval ?? "15m").toUpperCase()} BINANCE`,
    price: secondaryPriceRows.map((row) => point(row.time, row.close)).filter(Boolean),
    oi: secondaryOiRows.map((row) => point(row.timestamp, row.sumOpenInterestValue)).filter(Boolean),
    longLiq: [],
    shortLiq: [],
  };

  if (primary.price.length < 2 && primary.oi.length < 2 && secondary.price.length < 2) {
    return null;
  }

  const canvas = new RgbaCanvas(WIDTH, HEIGHT, [248, 250, 252, 255]);
  drawText(canvas, 62, 26, `${bundle.meta.coin} FUTURES MARKET CHART`, [15, 23, 42, 255], 3);
  drawLegend(canvas, 62, 58);
  drawPanel(canvas, { x: 62, y: 90, width: 1080, height: 310 }, primary);
  drawPanel(canvas, { x: 62, y: 460, width: 1080, height: 260 }, secondary);
  drawText(canvas, 62, 756, "BLUE PRICE | ORANGE OI | GREEN/RED LIQUIDATION", [71, 85, 105, 255], 2);

  return encodePng(WIDTH, HEIGHT, canvas.pixels);
}

function drawPanel(canvas, plot, series) {
  drawGrid(canvas, plot);
  drawText(canvas, plot.x, plot.y - 26, series.title, [15, 23, 42, 255], 2);

  if (series.longLiq.length || series.shortLiq.length) {
    drawLiquidationBars(canvas, {
      x: plot.x,
      y: plot.y + plot.height - 78,
      width: plot.width,
      height: 70,
    }, series.longLiq, series.shortLiq);
  }

  const oiInfo = series.oi.length >= 2
    ? drawLineSeries(canvas, plot, series.oi, [245, 158, 11, 255], 3, { topPadding: 22, bottomPadding: 28 })
    : null;
  const priceInfo = series.price.length >= 2
    ? drawLineSeries(canvas, plot, series.price, [37, 99, 235, 255], 4, { topPadding: 18, bottomPadding: 32 })
    : null;

  if (priceInfo) {
    drawHorizontalMarker(canvas, plot, priceInfo.lastY, [37, 99, 235, 120]);
    drawLabel(canvas, plot.x + plot.width - 178, Math.max(plot.y + 6, priceInfo.lastY - 14), `LAST ${formatChartMoney(priceInfo.last)}`, [37, 99, 235, 255]);
    drawLabel(canvas, plot.x + 12, plot.y + 10, `HI ${formatChartMoney(priceInfo.max)}`, [37, 99, 235, 255]);
    drawLabel(canvas, plot.x + 12, plot.y + plot.height - 30, `LO ${formatChartMoney(priceInfo.min)}`, [37, 99, 235, 255]);
  }

  if (oiInfo) {
    drawLabel(canvas, plot.x + plot.width - 178, plot.y + 34, `OI ${formatChartMoney(oiInfo.last)}`, [245, 158, 11, 255]);
  }

  drawBorder(canvas, plot, [100, 116, 139, 255]);
}

function getEndpointRows(bundle, key) {
  const endpoint = bundle.endpoints.find((item) => item.key === key);
  return asArray(responseData(endpoint?.body)).filter((row) => row && typeof row === "object");
}

function getSupplementRows(bundle, key) {
  const endpoint = asArray(bundle.supplement?.endpoints).find((item) => item.key === key);
  return asArray(endpoint?.body).filter((row) => row && typeof row === "object");
}

function point(time, value) {
  const x = toFiniteNumber(time);
  const y = toFiniteNumber(value);
  if (x === null || y === null) return null;
  return { time: x, value: y };
}

function drawGrid(canvas, plot) {
  canvas.fillRect(plot.x, plot.y, plot.width, plot.height, [255, 255, 255, 255]);
  for (let index = 0; index <= 5; index += 1) {
    const y = Math.round(plot.y + (plot.height / 5) * index);
    canvas.line(plot.x, y, plot.x + plot.width, y, [226, 232, 240, 255], 1);
  }
  for (let index = 0; index <= 8; index += 1) {
    const x = Math.round(plot.x + (plot.width / 8) * index);
    canvas.line(x, plot.y, x, plot.y + plot.height, [241, 245, 249, 255], 1);
  }
}

function drawLegend(canvas, x, y) {
  canvas.fillRect(x, y, 36, 10, [37, 99, 235, 255]);
  drawText(canvas, x + 46, y - 2, "PRICE", [71, 85, 105, 255], 2);
  canvas.fillRect(x + 150, y, 36, 10, [245, 158, 11, 255]);
  drawText(canvas, x + 196, y - 2, "OI", [71, 85, 105, 255], 2);
  canvas.fillRect(x + 255, y, 36, 10, [34, 197, 94, 255]);
  drawText(canvas, x + 301, y - 2, "LONG LIQ", [71, 85, 105, 255], 2);
  canvas.fillRect(x + 450, y, 36, 10, [239, 68, 68, 255]);
  drawText(canvas, x + 496, y - 2, "SHORT LIQ", [71, 85, 105, 255], 2);
}

function drawBorder(canvas, plot, color) {
  canvas.line(plot.x, plot.y, plot.x + plot.width, plot.y, color, 1);
  canvas.line(plot.x, plot.y + plot.height, plot.x + plot.width, plot.y + plot.height, color, 1);
  canvas.line(plot.x, plot.y, plot.x, plot.y + plot.height, color, 1);
  canvas.line(plot.x + plot.width, plot.y, plot.x + plot.width, plot.y + plot.height, color, 1);
}

function drawLineSeries(canvas, plot, points, color, thickness, { topPadding, bottomPadding }) {
  const values = points.map((item) => item.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const usableHeight = plot.height - topPadding - bottomPadding;
  const coords = points.map((item, index) => {
    const x = plot.x + (plot.width * index) / Math.max(points.length - 1, 1);
    const y = plot.y + topPadding + usableHeight - ((item.value - min) / span) * usableHeight;
    return [Math.round(x), Math.round(y)];
  });

  for (let index = 1; index < coords.length; index += 1) {
    canvas.line(coords[index - 1][0], coords[index - 1][1], coords[index][0], coords[index][1], color, thickness);
  }

  const last = points.at(-1)?.value ?? null;
  return { min, max, last, lastY: coords.at(-1)?.[1] ?? plot.y };
}

function drawHorizontalMarker(canvas, plot, y, color) {
  canvas.line(plot.x, y, plot.x + plot.width, y, color, 1);
}

function drawLiquidationBars(canvas, plot, longPoints, shortPoints) {
  const length = Math.max(longPoints.length, shortPoints.length);
  if (!length) return;

  const max = Math.max(1, ...longPoints.map((item) => item.value), ...shortPoints.map((item) => item.value));
  const slot = plot.width / length;
  const barWidth = Math.max(2, Math.floor(slot * 0.34));
  const mid = plot.y + plot.height / 2;

  for (let index = 0; index < length; index += 1) {
    const x = Math.round(plot.x + slot * index + slot / 2 - barWidth);
    const longHeight = Math.round(((longPoints[index]?.value ?? 0) / max) * (plot.height / 2 - 4));
    const shortHeight = Math.round(((shortPoints[index]?.value ?? 0) / max) * (plot.height / 2 - 4));
    canvas.fillRect(x, mid - longHeight, barWidth, longHeight, [34, 197, 94, 160]);
    canvas.fillRect(x + barWidth + 1, mid, barWidth, shortHeight, [239, 68, 68, 160]);
  }

  canvas.line(plot.x, Math.round(mid), plot.x + plot.width, Math.round(mid), [148, 163, 184, 255], 1);
}

function drawLabel(canvas, x, y, text, color) {
  const width = Math.min(180, text.length * 12 + 12);
  canvas.fillRect(x - 5, y - 5, width, 24, [255, 255, 255, 225]);
  canvas.line(x - 5, y - 5, x - 5 + width, y - 5, [203, 213, 225, 255], 1);
  canvas.line(x - 5, y + 19, x - 5 + width, y + 19, [203, 213, 225, 255], 1);
  drawText(canvas, x, y, text, color, 2);
}

function drawText(canvas, x, y, text, color, scale = 1) {
  let cursor = Math.round(x);
  const upper = String(text ?? "").toUpperCase();
  for (const char of upper) {
    const glyph = FONT[char] ?? FONT["?"];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let col = 0; col < glyph[row].length; col += 1) {
          if (glyph[row][col] === "1") {
            canvas.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

function formatChartMoney(value) {
  const number = toFiniteNumber(value);
  if (number === null) return "N/A";
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(number / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `$${number.toFixed(2)}`;
  return `$${number.toPrecision(4)}`;
}

class RgbaCanvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, background);
  }

  setPixel(x, y, color) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const index = (yi * this.width + xi) * 4;
    const alpha = (color[3] ?? 255) / 255;
    const inv = 1 - alpha;
    this.pixels[index] = Math.round(color[0] * alpha + this.pixels[index] * inv);
    this.pixels[index + 1] = Math.round(color[1] * alpha + this.pixels[index + 1] * inv);
    this.pixels[index + 2] = Math.round(color[2] * alpha + this.pixels[index + 2] * inv);
    this.pixels[index + 3] = 255;
  }

  fillRect(x, y, width, height, color) {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const endX = Math.min(this.width, Math.ceil(x + width));
    const endY = Math.min(this.height, Math.ceil(y + height));
    for (let yy = startY; yy < endY; yy += 1) {
      for (let xx = startX; xx < endX; xx += 1) {
        this.setPixel(xx, yy, color);
      }
    }
  }

  line(x0, y0, x1, y1, color, thickness = 1) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;

    while (true) {
      const radius = Math.floor(thickness / 2);
      this.fillRect(x - radius, y - radius, thickness, thickness, color);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawStart = y * (width * 4 + 1);
    raw[rawStart] = 0;
    rgba.copy(raw, rawStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ihdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "?": ["11110", "00001", "00001", "00110", "00100", "00000", "00100"],
  "$": ["01110", "10100", "10100", "01110", "00101", "00101", "11110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "01100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};
