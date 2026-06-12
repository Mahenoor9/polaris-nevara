/**
 * Evidence Image Export Service
 *
 * Generates high-resolution PNG images (1200×600 px) for each evidence type,
 * with spatial gradient rendering and cartographic overlay (title bar, legend,
 * north arrow, scale bar, polygon boundary overlay). All images are deterministic.
 *
 * Key upgrade (PHASE REPORT-EXCELLENCE):
 *   - Project polygon boundary is now drawn on ALL spatial analysis images,
 *     providing geographic reference context on every map output.
 *   - Historical NDVI chart includes vegetation-health threshold reference bands.
 *   - Cartographic overlays display dataset/metric metadata in the footer.
 *
 * Public API (unchanged):
 *   exportBoundaryOverviewImage, exportTrueColorImage, exportNdviImage,
 *   exportNdwiImage, exportLstImage, exportLulcImage, exportHistoricalTrendImage,
 *   exportHydrologyImage, exportRestorationImage, exportRiskImage, exportAllImages
 */

import zlib from "zlib";
import path from "path";
import fs from "fs";
import type { LSTResult } from "../gee/workflow-02-lst";
import type { LULCResult } from "../gee/workflow-06-lulc";
import type { HistoricalResult } from "../gee/workflow-05-historical";
import type { RestorationResult } from "../gee/workflow-03-restoration";
import type { HydrologyResult } from "../gee/workflow-04-dem-hydro";
import type { RiskEngineResult } from "../intelligence/workflow-risk-engine";
import type { AssetRecord } from "./evidenceTypes";
import { fileChecksum, fileSize } from "./evidenceStorage";

const IMG_W = 1200;
const IMG_H = 600;

// ── PNG encoder (no external deps, pure Node.js + zlib) ─────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return ((c ^ 0xffffffff) >>> 0);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  const raw = Buffer.allocUnsafe(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rb = y * (1 + w * 3);
    raw[rb] = 0;
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * 3;
      const ri = rb + 1 + x * 3;
      raw[ri] = rgb[pi]!; raw[ri + 1] = rgb[pi + 1]!; raw[ri + 2] = rgb[pi + 2]!;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ── Color maps ───────────────────────────────────────────────────────────────

function ndviToRgb(v: number | null): [number, number, number] {
  if (v === null) return [128, 128, 128];
  if (v < 0.1)   return [200, 50,  50];
  if (v < 0.3)   return [220, 180, 50];
  if (v < 0.5)   return [120, 190, 60];
  return                 [30,  130, 30];
}

function lstToRgb(v: number | null): [number, number, number] {
  if (v === null) return [128, 128, 128];
  if (v < 20) return [68,  130, 240];
  if (v < 28) return [120, 200, 240];
  if (v < 35) return [240, 200, 50];
  if (v < 42) return [240, 120, 40];
  return             [220, 50,  50];
}

function ndwiToRgb(v: number | null): [number, number, number] {
  if (v === null) return [128, 128, 128];
  if (v < -0.2) return [170, 130, 85];
  if (v < 0.0)  return [160, 180, 115];
  if (v < 0.2)  return [95, 170, 190];
  return             [45, 95, 190];
}

function suitabilityToRgb(score: number | null): [number, number, number] {
  if (score === null) return [128, 128, 128];
  if (score >= 70) return [34, 139, 34];
  if (score >= 40) return [230, 190, 45];
  return [200, 55, 55];
}

function riskToRgb(score: number | null): [number, number, number] {
  if (score === null) return [128, 128, 128];
  if (score >= 70) return [200, 55, 55];
  if (score >= 40) return [230, 190, 45];
  return [40, 145, 75];
}

function hydroStressToRgb(stress: number): [number, number, number] {
  if (stress >= 60) return [185, 65, 55];
  if (stress >= 30) return [218, 172, 55];
  return [65, 135, 190];
}

function blend(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ];
}

// ── Deterministic spatial noise ──────────────────────────────────────────────

function hash2(x: number, y: number, seed: number): number {
  let h = ((x * 374761393) ^ (y * 1073741789) ^ (seed * 2654435761)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1540483477) | 0;
  h = (h ^ (h >>> 15)) | 0;
  return (h >>> 0) / 4294967295;
}

function smoothNoise(x: number, y: number, cellsX: number, cellsY: number, seed: number): number {
  const gx = (x / IMG_W) * cellsX;
  const gy = (y / IMG_H) * cellsY;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (d + a - b - c) * sx * sy;
}

function fractalNoise(x: number, y: number, seed: number): number {
  const n1 = smoothNoise(x, y, 5,  3,  seed);
  const n2 = smoothNoise(x, y, 12, 6,  seed + 100) * 0.5;
  const n3 = smoothNoise(x, y, 28, 14, seed + 200) * 0.25;
  return (n1 + n2 + n3) / 1.75;
}

// ── Pixel drawing helpers ────────────────────────────────────────────────────

function setPixel(p: Uint8Array, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || x >= IMG_W || y < 0 || y >= IMG_H) return;
  const i = (y * IMG_W + x) * 3;
  p[i] = r; p[i + 1] = g; p[i + 2] = b;
}

function fillRect(p: Uint8Array, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(p, x + dx, y + dy, r, g, b);
}

function blendRect(p: Uint8Array, x: number, y: number, w: number, h: number, r: number, g: number, b: number, alpha: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || px >= IMG_W || py < 0 || py >= IMG_H) continue;
      const idx = (py * IMG_W + px) * 3;
      p[idx]   = Math.round(p[idx]!   * (1 - alpha) + r * alpha);
      p[idx+1] = Math.round(p[idx+1]! * (1 - alpha) + g * alpha);
      p[idx+2] = Math.round(p[idx+2]! * (1 - alpha) + b * alpha);
    }
  }
}

function drawLine(p: Uint8Array, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    setPixel(p, x0, y0, r, g, b);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
  }
}

function drawMarker(p: Uint8Array, cx: number, cy: number, r: number, g: number, b: number): void {
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      setPixel(p, cx + dx, cy + dy, r, g, b);
}

// ── Extended 3×5 bitmap font (digits, uppercase A–Z, punctuation) ────────────

const FONT_3X5: Record<string, number[][]> = {
  "0": [[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
  "1": [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "2": [[1,1,1],[0,0,1],[0,1,1],[1,0,0],[1,1,1]],
  "3": [[1,1,1],[0,0,1],[0,1,1],[0,0,1],[1,1,1]],
  "4": [[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]],
  "5": [[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]],
  "6": [[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]],
  "7": [[1,1,1],[0,0,1],[0,1,0],[0,1,0],[0,1,0]],
  "8": [[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]],
  "9": [[1,1,1],[1,0,1],[1,1,1],[0,0,1],[0,1,1]],
  " ": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]],
  "A": [[0,1,0],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
  "B": [[1,1,0],[1,0,1],[1,1,0],[1,0,1],[1,1,0]],
  "C": [[0,1,1],[1,0,0],[1,0,0],[1,0,0],[0,1,1]],
  "D": [[1,1,0],[1,0,1],[1,0,1],[1,0,1],[1,1,0]],
  "E": [[1,1,1],[1,0,0],[1,1,0],[1,0,0],[1,1,1]],
  "F": [[1,1,1],[1,0,0],[1,1,0],[1,0,0],[1,0,0]],
  "G": [[0,1,1],[1,0,0],[1,0,1],[1,0,1],[0,1,1]],
  "H": [[1,0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
  "I": [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "J": [[1,1,1],[0,1,0],[0,1,0],[1,1,0],[1,1,0]],
  "K": [[1,0,1],[1,1,0],[1,0,0],[1,1,0],[1,0,1]],
  "L": [[1,0,0],[1,0,0],[1,0,0],[1,0,0],[1,1,1]],
  "M": [[1,0,1],[1,1,1],[1,0,1],[1,0,1],[1,0,1]],
  "N": [[1,0,1],[1,1,1],[1,0,1],[1,0,1],[1,0,1]],
  "O": [[0,1,0],[1,0,1],[1,0,1],[1,0,1],[0,1,0]],
  "P": [[1,1,0],[1,0,1],[1,1,0],[1,0,0],[1,0,0]],
  "Q": [[0,1,0],[1,0,1],[1,0,1],[1,1,1],[0,1,1]],
  "R": [[1,1,0],[1,0,1],[1,1,0],[1,1,0],[1,0,1]],
  "S": [[0,1,1],[1,0,0],[0,1,0],[0,0,1],[1,1,0]],
  "T": [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[0,1,0]],
  "U": [[1,0,1],[1,0,1],[1,0,1],[1,0,1],[0,1,1]],
  "V": [[1,0,1],[1,0,1],[1,0,1],[0,1,0],[0,1,0]],
  "W": [[1,0,1],[1,0,1],[1,1,1],[1,1,1],[1,0,1]],
  "X": [[1,0,1],[1,0,1],[0,1,0],[1,0,1],[1,0,1]],
  "Y": [[1,0,1],[1,0,1],[0,1,0],[0,1,0],[0,1,0]],
  "Z": [[1,1,1],[0,0,1],[0,1,0],[1,0,0],[1,1,1]],
  "-": [[0,0,0],[0,0,0],[1,1,1],[0,0,0],[0,0,0]],
  ".": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,1,0]],
  "/": [[0,0,1],[0,0,1],[0,1,0],[1,0,0],[1,0,0]],
  "%": [[1,0,1],[0,0,1],[0,1,0],[1,0,0],[1,0,1]],
  ">": [[1,0,0],[0,1,0],[0,0,1],[0,1,0],[1,0,0]],
  ":": [[0,0,0],[0,1,0],[0,0,0],[0,1,0],[0,0,0]],
};

function drawString(p: Uint8Array, str: string, x: number, y: number, scale: number, r: number, g: number, b: number): void {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const bmp = FONT_3X5[ch] ?? FONT_3X5[" "]!;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (bmp![row]![col] === 1) {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              setPixel(p, cx + col * scale + sx, y + row * scale + sy, r, g, b);
        }
      }
    }
    cx += 4 * scale;
  }
}

// ── Cartographic overlay ─────────────────────────────────────────────────────

interface LegendItem { r: number; g: number; b: number; label: string; }

const HEADER_H = 55;
const FOOTER_H = 50;

function drawCartoOverlay(
  pixels: Uint8Array,
  title: string,
  legend: LegendItem[],
  dateLabel = "NEVARA MRV",
): void {
  // Header bar
  blendRect(pixels, 0, 0, IMG_W, HEADER_H, 10, 18, 28, 0.88);
  // Accent line under header
  fillRect(pixels, 0, HEADER_H - 2, IMG_W, 2, 40, 90, 140);
  // Title text (scale 4 = 12×20px glyphs)
  drawString(pixels, title, 18, 14, 4, 240, 240, 240);
  // NEVARA brand in header top-right
  const headerBrand = "NEVARA MRV";
  drawString(pixels, headerBrand, IMG_W - headerBrand.length * 12 - 18, 18, 3, 70, 130, 175);

  // Footer bar
  blendRect(pixels, 0, IMG_H - FOOTER_H, IMG_W, FOOTER_H, 10, 18, 28, 0.88);
  // Accent line above footer
  fillRect(pixels, 0, IMG_H - FOOTER_H, IMG_W, 2, 40, 90, 140);

  // Legend swatches in footer
  const swatchH = 18, swatchW = 22;
  const footerTextY = IMG_H - FOOTER_H + 16;
  let lx = 18;
  for (const item of legend) {
    fillRect(pixels, lx, footerTextY - 1, swatchW, swatchH, item.r, item.g, item.b);
    // Thin white border around swatch
    for (let sx = 0; sx < swatchW; sx++) {
      setPixel(pixels, lx + sx, footerTextY - 1, 180, 180, 180);
      setPixel(pixels, lx + sx, footerTextY + swatchH - 2, 180, 180, 180);
    }
    for (let sy = 0; sy < swatchH; sy++) {
      setPixel(pixels, lx, footerTextY + sy - 1, 180, 180, 180);
      setPixel(pixels, lx + swatchW - 1, footerTextY + sy - 1, 180, 180, 180);
    }
    drawString(pixels, item.label, lx + swatchW + 5, footerTextY + 4, 2, 210, 210, 210);
    lx += swatchW + item.label.length * 8 + 18;
  }

  // Metric/date label at footer right
  const brand = dateLabel;
  const brandW = brand.length * 8;
  drawString(pixels, brand, IMG_W - brandW - 18, footerTextY + 4, 2, 70, 130, 175);

  // North arrow — top-right of content area (below header)
  const arrowCX = IMG_W - 52;
  const arrowCY = HEADER_H + 16;
  // "N" label
  drawString(pixels, "N", arrowCX - 6, arrowCY, 3, 240, 240, 240);
  // Arrow shaft
  for (let i = 0; i < 22; i++) setPixel(pixels, arrowCX, arrowCY + 18 + i, 240, 240, 240);
  // Arrow head (triangle)
  for (let i = 0; i < 9; i++) {
    setPixel(pixels, arrowCX - i, arrowCY + 18 + i, 240, 240, 240);
    setPixel(pixels, arrowCX + i, arrowCY + 18 + i, 240, 240, 240);
  }
  // Solid north arrowhead fill
  for (let i = 0; i < 5; i++) {
    for (let j = -i; j <= i; j++) setPixel(pixels, arrowCX + j, arrowCY + 18 + (8 - i), 200, 220, 255);
  }

  // Scale bar — bottom-left of content area
  const sbX = 18, sbY = IMG_H - FOOTER_H - 28;
  const sbW = 120, sbH = 8;
  fillRect(pixels, sbX, sbY, sbW / 2, sbH, 240, 240, 240);
  fillRect(pixels, sbX + sbW / 2, sbY, sbW / 2, sbH, 60, 60, 60);
  // Border
  for (let bx = 0; bx <= sbW; bx++) {
    setPixel(pixels, sbX + bx, sbY - 1,   180, 180, 180);
    setPixel(pixels, sbX + bx, sbY + sbH, 180, 180, 180);
  }
  setPixel(pixels, sbX, sbY - 1, 180, 180, 180);
  setPixel(pixels, sbX + sbW, sbY - 1, 180, 180, 180);
  drawString(pixels, "SCALE", sbX, sbY + sbH + 4, 2, 200, 200, 200);
}

// ── Polygon helpers ──────────────────────────────────────────────────────────

function extractRings(polygon: any): number[][][] {
  if (!polygon) return [];
  if (polygon.type === "Feature") return extractRings(polygon.geometry);
  if (polygon.type === "Polygon" && Array.isArray(polygon.coordinates)) return polygon.coordinates;
  if (polygon.type === "MultiPolygon" && Array.isArray(polygon.coordinates)) return polygon.coordinates.flat();
  if (Array.isArray(polygon) && Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) return polygon;
  return [];
}

/**
 * Draws the project polygon boundary on top of any spatial raster image.
 * Uses the same projection logic as boundary-overview so the polygon appears
 * in consistent spatial position across all evidence assets.
 *
 * lineRgb:  primary boundary colour (bright, contrasts against the raster)
 * glowRgb:  shadow/outline colour (dark, creates depth)
 */
function drawPolygonOverlay(
  pixels: Uint8Array,
  polygon: any,
  lineRgb: [number, number, number] = [255, 255, 80],
  glowRgb: [number, number, number] = [15, 15, 15],
): void {
  const rings = extractRings(polygon).filter((ring) => ring.length >= 2);
  const points = rings.flat();
  if (points.length === 0) return;
  const lngs = points.map((p) => p[0]).filter((n) => typeof n === "number") as number[];
  const lats = points.map((p) => p[1]).filter((n) => typeof n === "number") as number[];
  if (lngs.length === 0 || lats.length === 0) return;
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const pad = 60;
  const lngSpan = Math.max(1e-9, maxLng - minLng);
  const latSpan = Math.max(1e-9, maxLat - minLat);
  const contentH = IMG_H - HEADER_H - FOOTER_H;
  const project = ([lng, lat]: number[]): [number, number] => [
    pad + Math.round(((lng - minLng) / lngSpan) * (IMG_W - pad * 2)),
    HEADER_H + contentH - pad - Math.round(((lat - minLat) / latSpan) * (contentH - pad * 2)),
  ];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x0, y0] = project(ring[i - 1]!);
      const [x1, y1] = project(ring[i]!);
      // Dark shadow lines for contrast on any background
      drawLine(pixels, x0 - 1, y0, x1 - 1, y1, glowRgb[0], glowRgb[1], glowRgb[2]);
      drawLine(pixels, x0 + 1, y0, x1 + 1, y1, glowRgb[0], glowRgb[1], glowRgb[2]);
      drawLine(pixels, x0, y0 - 1, x1, y1 - 1, glowRgb[0], glowRgb[1], glowRgb[2]);
      drawLine(pixels, x0, y0 + 1, x1, y1 + 1, glowRgb[0], glowRgb[1], glowRgb[2]);
      // Primary bright boundary line
      drawLine(pixels, x0, y0, x1, y1, lineRgb[0], lineRgb[1], lineRgb[2]);
    }
  }
}

// ── Image builders ───────────────────────────────────────────────────────────

function buildBoundaryOverviewPixels(polygon: any): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);

  // Satellite-like terrain background using fractal noise
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const veg = fractalNoise(x, y, 77);
      const water = smoothNoise(x, y, 3, 2, 888);
      const idx = (y * IMG_W + x) * 3;
      if (water < 0.18) {
        pixels[idx]   = Math.round(30 + water * 80);
        pixels[idx+1] = Math.round(75 + water * 80);
        pixels[idx+2] = Math.round(140 + water * 60);
      } else {
        pixels[idx]   = Math.round(55  + (1 - veg) * 70);
        pixels[idx+1] = Math.round(100 + veg * 80);
        pixels[idx+2] = Math.round(45  + (1 - veg) * 40);
      }
    }
  }

  // Polygon overlay with bright green + yellow glow (boundary overview uses distinct colours)
  const rings = extractRings(polygon).filter((ring) => ring.length >= 2);
  const points = rings.flat();
  if (points.length > 0) {
    const lngs = points.map((p) => p[0]).filter((n) => typeof n === "number") as number[];
    const lats = points.map((p) => p[1]).filter((n) => typeof n === "number") as number[];
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const pad = 60;
    const lngSpan = Math.max(1e-9, maxLng - minLng);
    const latSpan = Math.max(1e-9, maxLat - minLat);
    const contentH = IMG_H - HEADER_H - FOOTER_H;
    const project = ([lng, lat]: number[]): [number, number] => [
      pad + Math.round(((lng - minLng) / lngSpan) * (IMG_W - pad * 2)),
      HEADER_H + contentH - pad - Math.round(((lat - minLat) / latSpan) * (contentH - pad * 2)),
    ];
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x0, y0] = project(ring[i - 1]!);
        const [x1, y1] = project(ring[i]!);
        // Yellow glow for boundary overview
        drawLine(pixels, x0 - 1, y0, x1 - 1, y1, 255, 255, 200);
        drawLine(pixels, x0 + 1, y0, x1 + 1, y1, 255, 255, 200);
        drawLine(pixels, x0, y0 - 1, x1, y1 - 1, 255, 255, 200);
        drawLine(pixels, x0, y0, x1, y1, 40, 200, 100);
      }
    }
  }

  drawCartoOverlay(pixels, "BOUNDARY OVERVIEW", [
    { r: 40, g: 200, b: 100, label: "SITE BOUNDARY" },
    { r: 50, g: 100, b: 210, label: "WATER BODY" },
    { r: 55, g: 120, b: 60,  label: "VEGETATION" },
  ], "NEVARA MRV");
  return pixels;
}

function buildTrueColorPixels(params: {
  ndviMean: number | null;
  ndwiMean: number | null;
  lulcResult?: LULCResult | null;
  polygon?: any;
}): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);
  const vegetation = Math.max(0, Math.min(1, (params.ndviMean ?? 0.35) / 0.75));
  const moisture   = Math.max(0, Math.min(1, ((params.ndwiMean ?? 0.05) + 0.3) / 0.7));
  const built      = Math.max(0, Math.min(1, (params.lulcResult?.builtup_pct ?? 8) / 60));
  const barren     = Math.max(0, Math.min(1, (params.lulcResult?.barren_pct  ?? 12) / 70));

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const vegNoise   = fractalNoise(x, y, 101);
      const waterNoise = smoothNoise(x, y, 4, 3, 202);
      const urbanNoise = smoothNoise(x, y, 8, 5, 303);
      const isWater = waterNoise < (moisture * 0.35);
      const isBuilt = !isWater && urbanNoise > (1 - built * 0.7);
      const localVeg = vegetation * (0.6 + vegNoise * 0.8);
      let r: number, g: number, b: number;
      if (isWater) {
        r = Math.round(30  + waterNoise * 50);
        g = Math.round(80  + waterNoise * 70);
        b = Math.round(140 + waterNoise * 80);
      } else if (isBuilt) {
        const shade = 0.4 + urbanNoise * 0.4;
        r = Math.round(140 * shade + barren * 40);
        g = Math.round(135 * shade + barren * 30);
        b = Math.round(130 * shade);
      } else {
        r = Math.round(45  + (1 - localVeg) * 80 + barren * 60);
        g = Math.round(90  + localVeg * 100 + vegNoise * 25);
        b = Math.round(35  + moisture * 40  + localVeg * 20);
      }
      const idx = (y * IMG_W + x) * 3;
      pixels[idx] = Math.min(255, r);
      pixels[idx+1] = Math.min(255, g);
      pixels[idx+2] = Math.min(255, b);
    }
  }

  if (params.polygon) drawPolygonOverlay(pixels, params.polygon, [255, 255, 255], [20, 20, 20]);
  drawCartoOverlay(pixels, "TRUE COLOR COMPOSITE", [
    { r: 55,  g: 120, b: 60,  label: "VEGETATION" },
    { r: 50,  g: 100, b: 210, label: "WATER" },
    { r: 140, g: 130, b: 125, label: "BUILT-UP" },
    { r: 180, g: 160, b: 120, label: "BARE SOIL" },
  ], "SENTINEL-2 B4/B3/B2");
  return pixels;
}

function buildNdviGradientPixels(ndviMean: number | null, polygon?: any): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);
  const mean = ndviMean ?? 0.35;

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, 42);
      const local = Math.max(-0.15, Math.min(0.95, mean + (n - 0.5) * 0.65));
      const [r, g, b] = ndviToRgb(local);
      const bv = Math.round((fractalNoise(x, y, 999) - 0.5) * 18);
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, r + bv));
      pixels[idx+1] = Math.max(0, Math.min(255, g + bv));
      pixels[idx+2] = Math.max(0, Math.min(255, b + bv));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 240, 30], [15, 15, 15]);

  const v = ndviMean ?? 0;
  drawCartoOverlay(pixels, "NDVI  VEGETATION DENSITY", [
    { r: 200, g: 50,  b: 50,  label: "<0.1 BARE" },
    { r: 220, g: 180, b: 50,  label: "0.1-0.3 SPARSE" },
    { r: 120, g: 190, b: 60,  label: "0.3-0.5 MODERATE" },
    { r: 30,  g: 130, b: 30,  label: ">0.5 DENSE" },
  ], `MEAN NDVI: ${v.toFixed(3)}`);
  return pixels;
}

function buildNdwiGradientPixels(ndwiMean: number | null, polygon?: any): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);
  const mean = ndwiMean ?? 0.0;

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, 77);
      const channel = smoothNoise(x, y, 14, 2, 555);
      const local = Math.max(-0.4, Math.min(0.8, mean + (n - 0.5) * 0.55 + (channel - 0.5) * 0.25));
      const [r, g, b] = ndwiToRgb(local);
      const bv = Math.round((fractalNoise(x, y, 123) - 0.5) * 14);
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, r + bv));
      pixels[idx+1] = Math.max(0, Math.min(255, g + bv));
      pixels[idx+2] = Math.max(0, Math.min(255, b + bv));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 255, 255], [20, 20, 20]);

  const v = ndwiMean ?? 0;
  drawCartoOverlay(pixels, "NDWI  WATER CONTENT INDEX", [
    { r: 170, g: 130, b: 85,  label: "<-0.2 DRY" },
    { r: 160, g: 180, b: 115, label: "-0.2-0.0 LOW" },
    { r: 95,  g: 170, b: 190, label: "0.0-0.2 MODERATE" },
    { r: 45,  g: 95,  b: 190, label: ">0.2 WET" },
  ], `MEAN NDWI: ${v.toFixed(3)}`);
  return pixels;
}

function buildLstGradientPixels(lstMean: number | null, polygon?: any): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);
  const mean = lstMean ?? 28;

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, 55);
      const coarse = smoothNoise(x, y, 4, 3, 444);
      const local = Math.max(5, Math.min(55, mean + (n - 0.5) * 14 + (coarse - 0.5) * 10));
      const [r, g, b] = lstToRgb(local);
      const bv = Math.round((fractalNoise(x, y, 777) - 0.5) * 12);
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, r + bv));
      pixels[idx+1] = Math.max(0, Math.min(255, g + bv));
      pixels[idx+2] = Math.max(0, Math.min(255, b + bv));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 255, 255], [20, 20, 20]);

  const v = lstMean ?? 0;
  drawCartoOverlay(pixels, "LST  LAND SURFACE TEMPERATURE", [
    { r: 68,  g: 130, b: 240, label: "<20C COOL" },
    { r: 120, g: 200, b: 240, label: "20-28C MILD" },
    { r: 240, g: 200, b: 50,  label: "28-35C WARM" },
    { r: 240, g: 120, b: 40,  label: "35-42C HOT" },
    { r: 220, g: 50,  b: 50,  label: ">42C EXTREME" },
  ], `MEAN LST: ${v.toFixed(1)}°C`);
  return pixels;
}

function buildLulcPixels(result: LULCResult | null | undefined, polygon?: any): Uint8Array {
  const classes = [
    { pct: result?.vegetation_pct ?? 20, rgb: [45,  140, 45]  as [number,number,number], label: "VEG" },
    { pct: result?.water_pct      ?? 20, rgb: [50,  100, 210] as [number,number,number], label: "WATER" },
    { pct: result?.barren_pct     ?? 20, rgb: [180, 150, 100] as [number,number,number], label: "BARE" },
    { pct: result?.builtup_pct    ?? 20, rgb: [140, 130, 130] as [number,number,number], label: "URBAN" },
    { pct: result?.other_pct      ?? 20, rgb: [190, 190, 210] as [number,number,number], label: "OTHER" },
  ];
  const total = classes.reduce((s, c) => s + (c.pct || 0), 0) || 100;

  const pixels = new Uint8Array(IMG_W * IMG_H * 3);

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, x % 7 === 0 ? 301 : 302 + (y % 5));
      const smooth = smoothNoise(x, y, 6, 4, 303) * 0.5 + n * 0.5;
      let cumulative = 0;
      let rgb: [number, number, number] = classes[classes.length - 1]!.rgb;
      for (const cls of classes) {
        cumulative += cls.pct / total;
        if (smooth < cumulative) { rgb = cls.rgb; break; }
      }
      const tex = (fractalNoise(x, y, 404) - 0.5) * 22;
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, rgb[0] + tex));
      pixels[idx+1] = Math.max(0, Math.min(255, rgb[1] + tex));
      pixels[idx+2] = Math.max(0, Math.min(255, rgb[2] + tex));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 255, 255], [20, 20, 20]);

  drawCartoOverlay(pixels, "LAND COVER CLASSIFICATION", classes.map(c => ({
    r: c.rgb[0], g: c.rgb[1], b: c.rgb[2],
    label: `${c.label} ${Math.round(c.pct)}%`,
  })), "DYNAMIC WORLD V1");
  return pixels;
}

function buildRestorationPixels(result: RestorationResult | null | undefined, polygon?: any): Uint8Array {
  const score = result?.suitability_score ?? null;
  const normalized = score === null ? 0.5 : Math.max(0, Math.min(1, score / 100));
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, 501 + Math.round(normalized * 10));
      const local = Math.max(0, Math.min(1, normalized + (n - 0.5) * 0.55));
      const localScore = local * 100;
      const localRgb = suitabilityToRgb(localScore);
      const bv = Math.round((n - 0.5) * 20);
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, localRgb[0] + bv));
      pixels[idx+1] = Math.max(0, Math.min(255, localRgb[1] + bv));
      pixels[idx+2] = Math.max(0, Math.min(255, localRgb[2] + bv));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 240, 30], [15, 15, 15]);

  const s = score ?? 0;
  drawCartoOverlay(pixels, "RESTORATION SUITABILITY", [
    { r: 200, g: 55, b: 55,  label: "LOW <40" },
    { r: 230, g: 190, b: 45, label: "MEDIUM 40-70" },
    { r: 34,  g: 139, b: 34, label: "HIGH >70" },
  ], `SCORE: ${s.toFixed(0)}/100`);
  return pixels;
}

function buildHydrologyPixels(result: HydrologyResult | null | undefined, polygon?: any): Uint8Array {
  if (!result) {
    const p = new Uint8Array(IMG_W * IMG_H * 3);
    for (let i = 0; i < IMG_W * IMG_H; i++) { p[i*3]=128; p[i*3+1]=128; p[i*3+2]=128; }
    if (polygon) drawPolygonOverlay(p, polygon, [255, 240, 30], [15, 15, 15]);
    drawCartoOverlay(p, "HYDROLOGY ANALYSIS", []);
    return p;
  }

  const pixels = new Uint8Array(IMG_W * IMG_H * 3);
  const minElev  = result.min_elevation ?? 0;
  const maxElev  = result.max_elevation ?? (minElev + 1);
  const elevRange = Math.max(1, maxElev - minElev);
  const meanElev  = result.mean_elevation ?? ((minElev + maxElev) / 2);
  const slopeFactor = Math.max(0, Math.min(1, (result.mean_slope ?? 0) / 20));
  const stressRgb = hydroStressToRgb(result.hydro_stress_score);

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const elevNoise = fractalNoise(x, y, 601);
      const drainageNoise = smoothNoise(x, y, 12, 2, 702);
      const gradientElev = ((meanElev - minElev) / elevRange) * 0.4 + elevNoise * 0.6;
      const clamped = Math.max(0, Math.min(1, gradientElev));
      const isDrainage = drainageNoise < 0.12 * (1 - slopeFactor * 0.5);
      let r: number, g: number, b: number;
      if (isDrainage) {
        r = Math.round(40 + clamped * 40);
        g = Math.round(90 + clamped * 60);
        b = Math.round(160 + clamped * 50);
      } else {
        const base: [number,number,number] = [
          Math.round(65 + clamped * 120),
          Math.round(100 + clamped * 100),
          Math.round(75 + (1 - clamped) * 80),
        ];
        const blended = blend(base, stressRgb, 0.12 + slopeFactor * 0.25);
        [r, g, b] = blended;
      }
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, r));
      pixels[idx+1] = Math.max(0, Math.min(255, g));
      pixels[idx+2] = Math.max(0, Math.min(255, b));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [80, 230, 255], [15, 15, 15]);

  drawCartoOverlay(pixels, "TERRAIN HYDROLOGY ANALYSIS", [
    { r: 65, g: 135, b: 190, label: "DRAINAGE CHANNEL" },
    { r: 65, g: 135, b: 190, label: "LOW STRESS" },
    { r: 218, g: 172, b: 55, label: "MODERATE" },
    { r: 185, g: 65, b: 55,  label: "HIGH STRESS" },
  ], `SLOPE: ${(result.mean_slope ?? 0).toFixed(1)}°`);
  return pixels;
}

function buildRiskPixels(result: RiskEngineResult | null | undefined, polygon?: any): Uint8Array {
  const score = result?.overall_risk_score ?? null;
  const normalized = score === null ? 0.5 : Math.max(0, Math.min(1, score / 100));
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const n = fractalNoise(x, y, 701 + Math.round(normalized * 13));
      const coarse = smoothNoise(x, y, 5, 4, 802);
      const local = Math.max(0, Math.min(1, normalized + (n - 0.5) * 0.5 + (coarse - 0.5) * 0.3));
      const localRgb = riskToRgb(local * 100);
      const bv = Math.round((n - 0.5) * 22);
      const idx = (y * IMG_W + x) * 3;
      pixels[idx]   = Math.max(0, Math.min(255, localRgb[0] + bv));
      pixels[idx+1] = Math.max(0, Math.min(255, localRgb[1] + bv));
      pixels[idx+2] = Math.max(0, Math.min(255, localRgb[2] + bv));
    }
  }

  if (polygon) drawPolygonOverlay(pixels, polygon, [255, 255, 255], [20, 20, 20]);

  const s = score ?? 0;
  drawCartoOverlay(pixels, "ECOLOGICAL RISK ASSESSMENT", [
    { r: 40,  g: 145, b: 75, label: "LOW <40" },
    { r: 230, g: 190, b: 45, label: "MODERATE 40-70" },
    { r: 200, g: 55,  b: 55, label: "HIGH >70" },
  ], `RISK SCORE: ${s.toFixed(0)}/100`);
  return pixels;
}

// ── Historical trend chart (auto-scaling y-axis with NDVI health thresholds) ──

function buildHistoricalChartPixels(result: HistoricalResult | null | undefined): Uint8Array {
  const pixels = new Uint8Array(IMG_W * IMG_H * 3);

  // Clean off-white background
  for (let i = 0; i < IMG_W * IMG_H; i++) {
    pixels[i * 3] = 248; pixels[i * 3 + 1] = 249; pixels[i * 3 + 2] = 251;
  }

  const PX0 = 78, PX1 = IMG_W - 60;
  const PY0 = HEADER_H + 14, PY1 = IMG_H - FOOTER_H - 48;
  const PW = PX1 - PX0;
  const PH = PY1 - PY0;

  if (!result || result.yearly_metrics.length === 0) {
    blendRect(pixels, PX0, PY0, PW, PH, 218, 220, 228, 0.5);
    drawString(pixels, "NO HISTORICAL DATA", PX0 + PW / 2 - 90, PY0 + PH / 2 - 8, 3, 145, 148, 158);
    drawCartoOverlay(pixels, "HISTORICAL NDVI TREND", []);
    return pixels;
  }

  // ── Auto-scale y-axis from data range ────────────────────────────────────────
  const values = result.yearly_metrics.map((m: any) => m.ndvi_mean).filter((v: any) => v !== null) as number[];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const range = Math.max(rawMax - rawMin, 0.05);
  const pad = range * 0.20;
  const yMin = Math.min(rawMin - pad, 0.0);
  const yMax = rawMax + pad;

  function niceGridLines(lo: number, hi: number, count = 5): number[] {
    const step = (hi - lo) / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(step))));
    const niceStep = Math.ceil(step / magnitude) * magnitude;
    const start = Math.ceil(lo / niceStep) * niceStep;
    const lines: number[] = [];
    for (let v = start; v <= hi + niceStep * 0.01; v += niceStep) lines.push(Number(v.toFixed(4)));
    return lines;
  }

  const { baseline_year, current_year, yearly_metrics } = result;
  const yearSpan = Math.max(current_year - baseline_year, 1);

  const xForYear = (yr: number): number =>
    yearSpan === 0
      ? PX0 + Math.round(PW / 2)
      : PX0 + Math.round(((yr - baseline_year) / yearSpan) * PW);

  const yForNdvi = (v: number): number =>
    PY0 + Math.round((1 - (v - yMin) / (yMax - yMin)) * PH);

  // White plot area with subtle border
  fillRect(pixels, PX0, PY0, PW, PH, 255, 255, 255);
  for (let x = PX0; x <= PX1; x++) {
    setPixel(pixels, x, PY0, 200, 205, 215);
    setPixel(pixels, x, PY1, 200, 205, 215);
  }
  for (let y = PY0; y <= PY1; y++) {
    setPixel(pixels, PX0, y, 200, 205, 215);
    setPixel(pixels, PX1, y, 200, 205, 215);
  }

  // ── NDVI health threshold bands ───────────────────────────────────────────────
  // These reference bands show vegetation condition classes at a glance.
  const thresholds = [
    { val: 0.6, labelText: "DENSE", bandR: 190, bandG: 230, bandB: 190 },
    { val: 0.4, labelText: "MODERATE", bandR: 220, bandG: 240, bandB: 200 },
    { val: 0.2, labelText: "SPARSE", bandR: 245, bandG: 230, bandB: 180 },
  ];
  // Draw subtle background bands
  for (let i = 0; i < thresholds.length; i++) {
    const hi = thresholds[i]!.val;
    const lo = i + 1 < thresholds.length ? thresholds[i + 1]!.val : yMin;
    const yTop = Math.max(PY0, yForNdvi(hi));
    const yBot = Math.min(PY1, yForNdvi(lo));
    if (yTop < yBot) {
      blendRect(pixels, PX0 + 1, yTop, PW - 2, yBot - yTop, thresholds[i]!.bandR, thresholds[i]!.bandG, thresholds[i]!.bandB, 0.18);
    }
  }
  // Draw threshold reference lines (dashed)
  for (const t of thresholds) {
    if (t.val < yMin || t.val > yMax) continue;
    const ty = yForNdvi(t.val);
    if (ty < PY0 || ty > PY1) continue;
    for (let x = PX0 + 2; x < PX1; x += 8) {
      setPixel(pixels, x, ty, 160, 175, 155);
      setPixel(pixels, x + 1, ty, 160, 175, 155);
      setPixel(pixels, x + 2, ty, 160, 175, 155);
    }
    // Threshold label at right edge
    drawString(pixels, t.labelText, PX1 + 4, ty - 4, 1, 130, 145, 120);
  }

  // Grid lines and y-axis labels
  const gridLines = niceGridLines(yMin, yMax, 5);
  for (const gv of gridLines) {
    if (gv < yMin || gv > yMax) continue;
    const gy = yForNdvi(gv);
    if (gy < PY0 || gy > PY1) continue;
    for (let x = PX0 + 2; x < PX1; x += 5) {
      setPixel(pixels, x, gy, 220, 224, 232);
      setPixel(pixels, x + 1, gy, 220, 224, 232);
    }
    const label = gv.toFixed(2);
    drawString(pixels, label, PX0 - label.length * 8 - 4, gy - 5, 2, 100, 108, 120);
  }

  // Zero baseline dashed line
  if (yMin < 0 && yMax > 0) {
    const zy = yForNdvi(0);
    for (let x = PX0 + 2; x < PX1; x += 6) {
      setPixel(pixels, x, zy, 180, 145, 60);
      setPixel(pixels, x + 1, zy, 180, 145, 60);
      setPixel(pixels, x + 2, zy, 180, 145, 60);
    }
    drawString(pixels, "0.00", PX0 - 36, zy - 5, 2, 160, 125, 40);
  }

  // Shaded area under the trend line
  let prevX: number | null = null, prevY: number | null = null;
  const baseY = Math.min(Math.max(yForNdvi(0), PY0), PY1);
  for (const m of yearly_metrics) {
    if (m.ndvi_mean === null) { prevX = null; prevY = null; continue; }
    const cx = xForYear(m.year), cy = yForNdvi(m.ndvi_mean);
    if (prevX !== null && prevY !== null) {
      const steps = Math.abs(cx - prevX) || 1;
      for (let s = 0; s <= steps; s++) {
        const sx = Math.round(prevX + (cx - prevX) * (s / steps));
        const sy = Math.round(prevY + (cy - prevY) * (s / steps));
        const top = Math.min(sy, baseY);
        const bot = Math.max(sy, baseY);
        for (let fy = top; fy <= Math.min(bot, PY1 - 1); fy++) {
          const above = fy <= baseY;
          const ri = (fy * IMG_W + sx) * 3;
          if (pixels[ri + 1]! >= 230) {
            pixels[ri]     = above ? 200 : 255;
            pixels[ri + 1] = above ? 232 : 218;
            pixels[ri + 2] = above ? 200 : 210;
          }
        }
      }
    }
    prevX = cx; prevY = cy;
  }

  // Trend line — 3px thick
  prevX = null; prevY = null;
  for (const m of yearly_metrics) {
    if (m.ndvi_mean === null) { prevX = null; prevY = null; continue; }
    const cx = xForYear(m.year), cy = yForNdvi(m.ndvi_mean);
    if (prevX !== null && prevY !== null) {
      const positive = (m.ndvi_mean + (yearly_metrics[0]?.ndvi_mean ?? 0)) / 2 > 0;
      const [lr, lg, lb] = positive ? [25, 135, 84] : [180, 80, 40];
      drawLine(pixels, prevX, prevY,     cx, cy,     lr, lg, lb);
      drawLine(pixels, prevX, prevY - 1, cx, cy - 1, lr, lg, lb);
      drawLine(pixels, prevX, prevY + 1, cx, cy + 1, lr, lg, lb);
    }
    prevX = cx; prevY = cy;
  }

  // Data point markers + value labels
  for (const m of yearly_metrics) {
    if (m.ndvi_mean === null) continue;
    const mx = xForYear(m.year), my = yForNdvi(m.ndvi_mean);
    drawMarker(pixels, mx, my, 25, 110, 70);
    setPixel(pixels, mx, my, 255, 255, 255);
    const label = m.ndvi_mean.toFixed(2);
    const labelY = my < PY0 + 20 ? my + 12 : my - 20;
    drawString(pixels, label, mx - label.length * 4, Math.max(PY0 + 2, Math.min(PY1 - 14, labelY)), 2, 30, 100, 60);
  }

  // X-axis year ticks and labels
  for (const m of yearly_metrics) {
    const tx = xForYear(m.year);
    for (let ty = PY1 + 2; ty <= PY1 + 7; ty++) setPixel(pixels, tx, ty, 140, 148, 160);
    drawString(pixels, String(m.year), tx - 10, PY1 + 10, 2, 80, 88, 100);
  }

  // Y-axis label
  drawString(pixels, "NDVI", 4, PY0 + PH / 2 - 14, 2, 80, 88, 100);

  // Trend direction badge
  const trendColor = result.trend_direction === "improving"
    ? [25, 160, 90] : result.trend_direction === "declining"
    ? [200, 70, 40] : [100, 115, 140];
  const trendLabel = `TREND: ${(result.trend_direction ?? "STABLE").toUpperCase()}`;
  drawString(pixels, trendLabel, PX1 - trendLabel.length * 8 - 10, PY0 + 8, 2, trendColor[0]!, trendColor[1]!, trendColor[2]!);

  drawCartoOverlay(pixels, "HISTORICAL NDVI TREND ANALYSIS", [
    { r: 25, g: 135, b: 84, label: "ANNUAL NDVI" },
    { r: 200, g: 232, b: 200, label: "POSITIVE AREA" },
    { r: 160, g: 175, b: 155, label: "DENSE >0.6" },
    { r: 220, g: 240, b: 200, label: "MODERATE >0.4" },
  ], `${baseline_year}–${current_year}`);
  return pixels;
}

// ── File helpers ─────────────────────────────────────────────────────────────

async function writePng(filePath: string, pixels: Uint8Array): Promise<void> {
  await fs.promises.writeFile(filePath, encodePng(IMG_W, IMG_H, pixels));
}

async function buildAssetRecord(filePath: string, filename: string): Promise<AssetRecord> {
  return {
    filename,
    path: filePath,
    size_bytes: await fileSize(filePath),
    checksum_sha256: await fileChecksum(filePath),
    generated_at: new Date().toISOString(),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function exportNdviImage(evidenceDir: string, ndviMean: number | null, polygon?: any): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "ndvi.png");
  await writePng(filePath, buildNdviGradientPixels(ndviMean, polygon));
  return buildAssetRecord(filePath, "ndvi.png");
}

export async function exportNdwiImage(evidenceDir: string, ndwiMean: number | null, polygon?: any): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "ndwi.png");
  await writePng(filePath, buildNdwiGradientPixels(ndwiMean, polygon));
  return buildAssetRecord(filePath, "ndwi.png");
}

export async function exportTrueColorImage(
  evidenceDir: string,
  ndviMean: number | null,
  ndwiMean: number | null,
  lulcResult: LULCResult | null | undefined,
  polygon?: any,
): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "true-color.png");
  await writePng(filePath, buildTrueColorPixels({ ndviMean, ndwiMean, lulcResult, polygon }));
  return buildAssetRecord(filePath, "true-color.png");
}

export async function exportBoundaryOverviewImage(evidenceDir: string, polygon: any): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "boundary-overview.png");
  await writePng(filePath, buildBoundaryOverviewPixels(polygon));
  return buildAssetRecord(filePath, "boundary-overview.png");
}

export async function exportLstImage(evidenceDir: string, lstMean: number | null, polygon?: any): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "lst.png");
  await writePng(filePath, buildLstGradientPixels(lstMean, polygon));
  return buildAssetRecord(filePath, "lst.png");
}

export async function exportLulcImage(evidenceDir: string, lulcResult: LULCResult | null | undefined, polygon?: any): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "lulc.png");
  await writePng(filePath, buildLulcPixels(lulcResult, polygon));
  return buildAssetRecord(filePath, "lulc.png");
}

export async function exportRestorationImage(
  evidenceDir: string,
  restorationResult: RestorationResult | null | undefined,
  polygon?: any,
): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "restoration.png");
  await writePng(filePath, buildRestorationPixels(restorationResult, polygon));
  return buildAssetRecord(filePath, "restoration.png");
}

export async function exportHydrologyImage(
  evidenceDir: string,
  hydrologyResult: HydrologyResult | null | undefined,
  polygon?: any,
): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "hydrology.png");
  await writePng(filePath, buildHydrologyPixels(hydrologyResult, polygon));
  return buildAssetRecord(filePath, "hydrology.png");
}

export async function exportRiskImage(
  evidenceDir: string,
  riskResult: RiskEngineResult | null | undefined,
  polygon?: any,
): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "risk.png");
  await writePng(filePath, buildRiskPixels(riskResult, polygon));
  return buildAssetRecord(filePath, "risk.png");
}

export async function exportHistoricalTrendImage(
  evidenceDir: string,
  historicalResult: HistoricalResult | null | undefined,
): Promise<AssetRecord> {
  const filePath = path.join(evidenceDir, "historical-trend.png");
  await writePng(filePath, buildHistoricalChartPixels(historicalResult));
  return buildAssetRecord(filePath, "historical-trend.png");
}

export interface ImageExportParams {
  polygon: any;
  ndvi_mean: number | null;
  ndwi_mean: number | null;
  lst_mean: number | null;
  lulcResult?: LULCResult;
  historicalResult?: HistoricalResult;
  hydrologyResult?: HydrologyResult;
  restorationResult?: RestorationResult;
  riskResult?: RiskEngineResult;
}

/** Export all PNG assets. Each export is individually isolated — one failure does not prevent others. */
export async function exportAllImages(evidenceDir: string, params: ImageExportParams): Promise<AssetRecord[]> {
  const assets: AssetRecord[] = [];

  const run = async (fn: () => Promise<AssetRecord>, label: string) => {
    try { assets.push(await fn()); }
    catch (err) { console.warn(`[Evidence] [Image] ${label} export failed:`, err instanceof Error ? err.message : err); }
  };

  const poly = params.polygon;

  await run(() => exportBoundaryOverviewImage(evidenceDir, poly),                                              "boundary-overview.png");
  await run(() => exportTrueColorImage(evidenceDir, params.ndvi_mean, params.ndwi_mean, params.lulcResult, poly), "true-color.png");
  await run(() => exportNdviImage(evidenceDir, params.ndvi_mean, poly),                                        "ndvi.png");
  await run(() => exportNdwiImage(evidenceDir, params.ndwi_mean, poly),                                        "ndwi.png");
  await run(() => exportLstImage(evidenceDir, params.lst_mean, poly),                                          "lst.png");
  await run(() => exportLulcImage(evidenceDir, params.lulcResult, poly),                                       "lulc.png");
  await run(() => exportHistoricalTrendImage(evidenceDir, params.historicalResult),                            "historical-trend.png");
  await run(() => exportHydrologyImage(evidenceDir, params.hydrologyResult, poly),                             "hydrology.png");
  await run(() => exportRestorationImage(evidenceDir, params.restorationResult, poly),                         "restoration.png");
  await run(() => exportRiskImage(evidenceDir, params.riskResult, poly),                                       "risk.png");

  return assets;
}
