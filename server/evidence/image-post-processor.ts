/**
 * Image Post-Processor — PHASE REPORT-EXCELLENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * Applies professional cartographic overlays to any PNG (GEE or procedural)
 * using pure Node.js — no external image library required.
 *
 * Pipeline: PNG bytes → decode(RGBA) → draw overlays → encode(RGB) → PNG bytes
 *
 * Overlays added:
 *   - Dark header bar: title + dataset attribution + capture date
 *   - Dark footer bar: legend swatches + NEVARA brand + project name
 *   - North arrow (top-right)
 *   - Scale bar (bottom-left of content area)
 *   - Polygon boundary outline (when coordinates provided)
 */
import zlib from "zlib";
import path from "path";
import fs from "fs";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LegendItem {
  r: number; g: number; b: number;
  label: string;
}

export interface CartographicParams {
  title: string;
  subtitle?: string | null;    // dataset name, e.g. "Sentinel-2 SR"
  captureDate?: string | null;
  projectName?: string | null;
  ecosystemType?: string | null;
  legend?: LegendItem[];
  polygon?: any;               // GeoJSON polygon or coordinate array
}

// ── PNG decoder (pure Node + zlib) ───────────────────────────────────────────

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array; // row-major RGBA
}

function unfilterRow(row: Buffer, prev: Buffer, bpp: number) {
  const filter = row[0]!;
  const data = row.subarray(1);
  if (filter === 0) return;
  for (let i = 0; i < data.length; i++) {
    const a = i >= bpp ? data[i - bpp]! : 0;
    const b = prev[i + 1] ?? 0;
    const c = i >= bpp ? (prev[i - bpp + 1] ?? 0) : 0;
    if (filter === 1) {
      data[i] = (data[i]! + a) & 0xff;
    } else if (filter === 2) {
      data[i] = (data[i]! + b) & 0xff;
    } else if (filter === 3) {
      data[i] = (data[i]! + Math.floor((a + b) / 2)) & 0xff;
    } else if (filter === 4) {
      // Paeth
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      data[i] = (data[i]! + pr) & 0xff;
    }
  }
}

export function decodePng(buf: Buffer): RgbaImage | null {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const colorType = buf[25]!;
    const bpp = (colorType === 6 ? 4 : 3); // 6=RGBA, 2=RGB
    const stride = 1 + w * bpp;

    const idatChunks: Buffer[] = [];
    let i = 8;
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString("ascii");
      if (type === "IDAT") idatChunks.push(buf.subarray(i + 8, i + 8 + len));
      if (type === "IEND") break;
      i += 12 + len;
    }
    if (!idatChunks.length) return null;

    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const pixels = new Uint8Array(w * h * 4);
    const zero = Buffer.alloc(stride);

    for (let y = 0; y < h; y++) {
      const row = raw.subarray(y * stride, (y + 1) * stride) as Buffer;
      const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) as Buffer : zero;
      unfilterRow(row, prev, bpp);
      for (let x = 0; x < w; x++) {
        const src = 1 + x * bpp;
        const dst = (y * w + x) * 4;
        pixels[dst]     = row[src]!;
        pixels[dst + 1] = row[src + 1]!;
        pixels[dst + 2] = row[src + 2]!;
        pixels[dst + 3] = bpp === 4 ? row[src + 3]! : 255;
      }
    }
    return { width: w, height: h, pixels };
  } catch {
    return null;
  }
}

// ── PNG encoder (RGB, no alpha — output images are always opaque) ─────────────

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
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function encodePngRgb(w: number, h: number, pixels: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  const raw = Buffer.allocUnsafe(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = y * (1 + w * 3) + 1 + x * 3;
      raw[dst]     = pixels[src]!;
      raw[dst + 1] = pixels[src + 1]!;
      raw[dst + 2] = pixels[src + 2]!;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function px(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a = 255) {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  if (a >= 255) {
    img.pixels[i] = r; img.pixels[i + 1] = g; img.pixels[i + 2] = b; img.pixels[i + 3] = 255;
  } else {
    const f = a / 255;
    img.pixels[i]     = Math.round(img.pixels[i]! * (1 - f) + r * f);
    img.pixels[i + 1] = Math.round(img.pixels[i + 1]! * (1 - f) + g * f);
    img.pixels[i + 2] = Math.round(img.pixels[i + 2]! * (1 - f) + b * f);
    img.pixels[i + 3] = 255;
  }
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 255) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      px(img, x + dx, y + dy, r, g, b, a);
}

function drawLine(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    px(img, x0, y0, r, g, b);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
  }
}

// ── 5×7 bitmap font — cleaner than the 3×5 used in imageExportService ────────
// Each character is 5 wide × 7 tall (1 = lit pixel)
const FONT_5X7: Record<string, number[]> = {
  "A":[0x0e,0x11,0x11,0x1f,0x11,0x11,0x00],"B":[0x1e,0x11,0x11,0x1e,0x11,0x1e,0x00],
  "C":[0x0e,0x11,0x10,0x10,0x11,0x0e,0x00],"D":[0x1e,0x11,0x11,0x11,0x11,0x1e,0x00],
  "E":[0x1f,0x10,0x10,0x1e,0x10,0x1f,0x00],"F":[0x1f,0x10,0x10,0x1e,0x10,0x10,0x00],
  "G":[0x0e,0x11,0x10,0x17,0x11,0x0f,0x00],"H":[0x11,0x11,0x11,0x1f,0x11,0x11,0x00],
  "I":[0x0e,0x04,0x04,0x04,0x04,0x0e,0x00],"J":[0x01,0x01,0x01,0x01,0x11,0x0e,0x00],
  "K":[0x11,0x12,0x14,0x18,0x14,0x12,0x11],"L":[0x10,0x10,0x10,0x10,0x10,0x1f,0x00],
  "M":[0x11,0x1b,0x15,0x11,0x11,0x11,0x00],"N":[0x11,0x19,0x15,0x13,0x11,0x11,0x00],
  "O":[0x0e,0x11,0x11,0x11,0x11,0x0e,0x00],"P":[0x1e,0x11,0x11,0x1e,0x10,0x10,0x00],
  "Q":[0x0e,0x11,0x11,0x15,0x12,0x0d,0x00],"R":[0x1e,0x11,0x11,0x1e,0x14,0x12,0x11],
  "S":[0x0f,0x10,0x10,0x0e,0x01,0x1e,0x00],"T":[0x1f,0x04,0x04,0x04,0x04,0x04,0x00],
  "U":[0x11,0x11,0x11,0x11,0x11,0x0e,0x00],"V":[0x11,0x11,0x11,0x0a,0x0a,0x04,0x00],
  "W":[0x11,0x11,0x15,0x15,0x1b,0x11,0x00],"X":[0x11,0x0a,0x04,0x04,0x0a,0x11,0x00],
  "Y":[0x11,0x0a,0x04,0x04,0x04,0x04,0x00],"Z":[0x1f,0x02,0x04,0x08,0x10,0x1f,0x00],
  "0":[0x0e,0x11,0x13,0x15,0x19,0x0e,0x00],"1":[0x04,0x0c,0x04,0x04,0x04,0x0e,0x00],
  "2":[0x0e,0x11,0x01,0x06,0x08,0x1f,0x00],"3":[0x1f,0x02,0x06,0x02,0x11,0x0e,0x00],
  "4":[0x02,0x06,0x0a,0x12,0x1f,0x02,0x00],"5":[0x1f,0x10,0x1e,0x01,0x11,0x0e,0x00],
  "6":[0x06,0x08,0x1e,0x11,0x11,0x0e,0x00],"7":[0x1f,0x01,0x02,0x04,0x08,0x08,0x00],
  "8":[0x0e,0x11,0x11,0x0e,0x11,0x0e,0x00],"9":[0x0e,0x11,0x11,0x0f,0x01,0x0c,0x00],
  " ":[0x00,0x00,0x00,0x00,0x00,0x00,0x00],".":[0x00,0x00,0x00,0x00,0x00,0x04,0x00],
  "/":[0x01,0x02,0x04,0x08,0x10,0x00,0x00],"-":[0x00,0x00,0x1f,0x00,0x00,0x00,0x00],
  ":":[0x00,0x04,0x00,0x00,0x04,0x00,0x00],"(":[0x02,0x04,0x04,0x04,0x04,0x02,0x00],
  ")":[0x08,0x04,0x04,0x04,0x04,0x08,0x00],"%":[0x11,0x02,0x04,0x08,0x11,0x00,0x00],
  ">":[0x10,0x08,0x04,0x08,0x10,0x00,0x00],"<":[0x01,0x02,0x04,0x02,0x01,0x00,0x00],
  "+":[0x00,0x04,0x0e,0x04,0x00,0x00,0x00],"*":[0x00,0x15,0x0e,0x15,0x00,0x00,0x00],
  "!":[0x04,0x04,0x04,0x04,0x00,0x04,0x00],"#":[0x0a,0x1f,0x0a,0x1f,0x0a,0x00,0x00],
  ",":[0x00,0x00,0x00,0x00,0x04,0x08,0x00],"'":[0x04,0x04,0x00,0x00,0x00,0x00,0x00],
  "°":[0x06,0x06,0x00,0x00,0x00,0x00,0x00],
};

export function drawText(img: RgbaImage, text: string, x: number, y: number, scale: number, r: number, g: number, b: number) {
  let cx = x;
  const charW = 5, charH = 7;
  for (const ch of text.toUpperCase()) {
    const bits = FONT_5X7[ch] ?? FONT_5X7[" "]!;
    for (let row = 0; row < charH; row++) {
      for (let col = 0; col < charW; col++) {
        if (bits[row]! & (1 << (charW - 1 - col))) {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              px(img, cx + col * scale + sx, y + row * scale + sy, r, g, b);
        }
      }
    }
    cx += (charW + 1) * scale;
  }
}

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale;
}

// ── Cartographic overlay ───────────────────────────────────────────────────────

const HEADER_H = 46;
const FOOTER_H = 44;
const ACCENT_R = 20, ACCENT_G = 130, ACCENT_B = 140; // teal accent
const HDR_R = 12, HDR_G = 20, HDR_B = 28; // very dark navy

export function applyCartographicOverlay(img: RgbaImage, params: CartographicParams): void {
  const { width: W, height: H } = img;

  // ── Header bar ────────────────────────────────────────────────────────────
  fillRect(img, 0, 0, W, HEADER_H, HDR_R, HDR_G, HDR_B, 235);
  // Teal accent line
  fillRect(img, 0, HEADER_H - 3, W, 3, ACCENT_R, ACCENT_G, ACCENT_B);

  // Title (scale 3 = 15px effective height)
  const titleMax = Math.floor((W * 0.55) / (6 * 3));
  const titleText = params.title.slice(0, titleMax).toUpperCase();
  drawText(img, titleText, 14, 8, 3, 235, 240, 245);

  // Subtitle / date (scale 2)
  if (params.captureDate || params.subtitle) {
    const subParts: string[] = [];
    if (params.subtitle) subParts.push(params.subtitle);
    if (params.captureDate) subParts.push(params.captureDate);
    const subText = subParts.join("  ·  ").slice(0, 60);
    drawText(img, subText, 14, 30, 2, 130, 160, 180);
  }

  // Project name / ecosystem (right-aligned in header)
  if (params.projectName) {
    const projText = (params.projectName + (params.ecosystemType ? `  ·  ${params.ecosystemType}` : "")).slice(0, 38);
    const px2 = W - textWidth(projText, 2) - 14;
    if (px2 > W * 0.5) drawText(img, projText, px2, 30, 2, 100, 150, 170);
  }

  // ── Footer bar ────────────────────────────────────────────────────────────
  const footerY = H - FOOTER_H;
  fillRect(img, 0, footerY, W, FOOTER_H, HDR_R, HDR_G, HDR_B, 235);
  // Teal accent line above footer
  fillRect(img, 0, footerY, W, 3, ACCENT_R, ACCENT_G, ACCENT_B);

  // Legend swatches
  const legend = params.legend ?? [];
  const swatchW = 20, swatchH = 14;
  const legY = footerY + 16;
  let lx = 14;
  for (const item of legend.slice(0, 8)) {
    // Swatch
    fillRect(img, lx, legY, swatchW, swatchH, item.r, item.g, item.b);
    // Swatch border
    for (let sx = 0; sx < swatchW; sx++) {
      px(img, lx + sx, legY, 80, 90, 100);
      px(img, lx + sx, legY + swatchH - 1, 80, 90, 100);
    }
    for (let sy = 0; sy < swatchH; sy++) {
      px(img, lx, legY + sy, 80, 90, 100);
      px(img, lx + swatchW - 1, legY + sy, 80, 90, 100);
    }
    // Label (scale 2)
    const label = item.label.slice(0, 14);
    drawText(img, label, lx + swatchW + 4, legY + 2, 2, 195, 205, 215);
    lx += swatchW + textWidth(label, 2) + 16;
    if (lx > W * 0.82) break;
  }

  // NEVARA branding (right footer)
  const brand = "NEVARA MRV";
  const bx = W - textWidth(brand, 2) - 14;
  drawText(img, brand, bx, legY + 2, 2, ACCENT_R, ACCENT_G, ACCENT_B);

  // ── North arrow (top-right of content area) ────────────────────────────────
  const arrowCX = W - 42;
  const arrowCY = HEADER_H + 16;
  drawText(img, "N", arrowCX - 4, arrowCY, 2, 240, 240, 240);
  const shaftTop = arrowCY + 18;
  for (let i = 0; i < 20; i++) px(img, arrowCX, shaftTop + i, 230, 230, 230);
  for (let i = 0; i < 8; i++) {
    px(img, arrowCX - i, shaftTop + i, 230, 230, 230);
    px(img, arrowCX + i, shaftTop + i, 230, 230, 230);
  }

  // ── Scale bar (bottom-left of content area) ────────────────────────────────
  const sbX = 14, sbY = H - FOOTER_H - 22;
  const sbW = 80;
  fillRect(img, sbX, sbY, sbW / 2, 8, 240, 240, 240);
  fillRect(img, sbX + sbW / 2, sbY, sbW / 2, 8, 60, 70, 80);
  for (let bx = 0; bx <= sbW; bx++) {
    px(img, sbX + bx, sbY - 1, 150, 160, 170);
    px(img, sbX + bx, sbY + 8, 150, 160, 170);
  }
  drawText(img, "SCALE", sbX, sbY + 11, 2, 160, 170, 180);
}

// ── Polygon overlay ───────────────────────────────────────────────────────────

function flattenCoords(poly: any): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (node: any) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") { out.push([node[0], node[1]]); return; }
    for (const c of node) walk(c);
  };
  if (poly && typeof poly === "object" && !Array.isArray(poly) && Array.isArray(poly.coordinates)) walk(poly.coordinates);
  else walk(poly);
  return out;
}

export function applyPolygonOverlay(img: RgbaImage, polygon: any, padFraction = 0.30) {
  const coords = flattenCoords(polygon);
  if (coords.length < 2) return;

  const lngs = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);

  const padLng = Math.max((maxLng - minLng) * padFraction, 0.001);
  const padLat = Math.max((maxLat - minLat) * padFraction, 0.001);
  minLng -= padLng; maxLng += padLng;
  minLat -= padLat; maxLat += padLat;

  const contentH = img.height - HEADER_H - FOOTER_H;
  const lngSpan = Math.max(maxLng - minLng, 1e-9);
  const latSpan = Math.max(maxLat - minLat, 1e-9);

  const project = ([lng, lat]: [number, number]): [number, number] => [
    Math.round(((lng - minLng) / lngSpan) * img.width),
    Math.round(HEADER_H + contentH - ((lat - minLat) / latSpan) * contentH),
  ];

  // Draw 3-pixel yellow boundary
  const pts = coords.map(project);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    drawLine(img, x0, y0, x1, y1, 255, 230, 30);
    drawLine(img, x0 + 1, y0, x1 + 1, y1, 255, 230, 30);
    drawLine(img, x0, y0 + 1, x1, y1 + 1, 255, 230, 30);
  }
  // Close ring
  if (pts.length > 1) {
    const [x0, y0] = pts[pts.length - 1]!;
    const [x1, y1] = pts[0]!;
    drawLine(img, x0, y0, x1, y1, 255, 230, 30);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Read a PNG file, apply cartographic overlays, write back as RGB PNG.
 * Returns true on success, false if the file cannot be decoded (leaves file untouched).
 */
export async function postProcessImage(
  filePath: string,
  params: CartographicParams,
): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(filePath);
    const img = decodePng(raw);
    if (!img) return false;

    if (params.polygon) {
      applyPolygonOverlay(img, params.polygon);
    }
    applyCartographicOverlay(img, params);

    const encoded = encodePngRgb(img.width, img.height, img.pixels);
    await fs.promises.writeFile(filePath, encoded);
    return true;
  } catch {
    return false;
  }
}
