import { deflateSync } from "node:zlib";
import { asArray, responseData, toFiniteNumber } from "./util.js";

const WIDTH = 1000;
const HEIGHT = 560;

export function createMarketChart(bundle) {
  const priceRows = getEndpointRows(bundle, "priceHistory");
  const oiRows = getEndpointRows(bundle, "openInterestAggregatedHistory");
  const liqRows = getEndpointRows(bundle, "liquidationAggregatedHistory");

  const priceSeries = priceRows.map((row) => toFiniteNumber(row.close)).filter((value) => value !== null);
  const oiSeries = oiRows.map((row) => toFiniteNumber(row.close)).filter((value) => value !== null);
  const longLiqSeries = liqRows
    .map((row) => toFiniteNumber(row.aggregated_long_liquidation_usd))
    .filter((value) => value !== null);
  const shortLiqSeries = liqRows
    .map((row) => toFiniteNumber(row.aggregated_short_liquidation_usd))
    .filter((value) => value !== null);

  if (priceSeries.length < 2 && oiSeries.length < 2 && longLiqSeries.length < 1 && shortLiqSeries.length < 1) {
    return null;
  }

  const canvas = new RgbaCanvas(WIDTH, HEIGHT, [250, 252, 255, 255]);
  const plot = { x: 70, y: 56, width: WIDTH - 120, height: HEIGHT - 126 };
  const bars = { x: plot.x, y: plot.y + plot.height - 110, width: plot.width, height: 100 };

  drawGrid(canvas, plot);
  drawLegend(canvas);

  if (longLiqSeries.length || shortLiqSeries.length) {
    drawLiquidationBars(canvas, bars, longLiqSeries, shortLiqSeries);
  }

  if (oiSeries.length >= 2) {
    drawLineSeries(canvas, plot, oiSeries, [245, 158, 11, 255], 3);
  }

  if (priceSeries.length >= 2) {
    drawLineSeries(canvas, plot, priceSeries, [37, 99, 235, 255], 3);
  }

  drawBorder(canvas, plot, [92, 107, 132, 255]);
  return encodePng(WIDTH, HEIGHT, canvas.pixels);
}

function getEndpointRows(bundle, key) {
  const endpoint = bundle.endpoints.find((item) => item.key === key);
  return asArray(responseData(endpoint?.body)).filter((row) => row && typeof row === "object");
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

function drawLegend(canvas) {
  canvas.fillRect(70, 22, 42, 10, [37, 99, 235, 255]);
  canvas.fillRect(150, 22, 42, 10, [245, 158, 11, 255]);
  canvas.fillRect(230, 22, 42, 10, [34, 197, 94, 255]);
  canvas.fillRect(310, 22, 42, 10, [239, 68, 68, 255]);
}

function drawBorder(canvas, plot, color) {
  canvas.line(plot.x, plot.y, plot.x + plot.width, plot.y, color, 1);
  canvas.line(plot.x, plot.y + plot.height, plot.x + plot.width, plot.y + plot.height, color, 1);
  canvas.line(plot.x, plot.y, plot.x, plot.y + plot.height, color, 1);
  canvas.line(plot.x + plot.width, plot.y, plot.x + plot.width, plot.y + plot.height, color, 1);
}

function drawLineSeries(canvas, plot, values, color, thickness) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = plot.x + (plot.width * index) / Math.max(values.length - 1, 1);
    const y = plot.y + plot.height - ((value - min) / span) * (plot.height - 18) - 9;
    return [Math.round(x), Math.round(y)];
  });

  for (let index = 1; index < points.length; index += 1) {
    canvas.line(points[index - 1][0], points[index - 1][1], points[index][0], points[index][1], color, thickness);
  }
}

function drawLiquidationBars(canvas, plot, longValues, shortValues) {
  const length = Math.max(longValues.length, shortValues.length);
  if (!length) return;

  const max = Math.max(1, ...longValues, ...shortValues);
  const slot = plot.width / length;
  const barWidth = Math.max(2, Math.floor(slot * 0.36));
  const mid = plot.y + plot.height / 2;

  for (let index = 0; index < length; index += 1) {
    const x = Math.round(plot.x + slot * index + slot / 2 - barWidth);
    const longHeight = Math.round(((longValues[index] ?? 0) / max) * (plot.height / 2 - 4));
    const shortHeight = Math.round(((shortValues[index] ?? 0) / max) * (plot.height / 2 - 4));
    canvas.fillRect(x, mid - longHeight, barWidth, longHeight, [34, 197, 94, 180]);
    canvas.fillRect(x + barWidth + 1, mid, barWidth, shortHeight, [239, 68, 68, 180]);
  }

  canvas.line(plot.x, Math.round(mid), plot.x + plot.width, Math.round(mid), [148, 163, 184, 255], 1);
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
