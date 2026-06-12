/**
 * Satellite boundary preview generator
 *
 * Composites ArcGIS World Imagery tiles onto a canvas, draws the polygon
 * boundary with teal styling, and returns a data-URL PNG.
 *
 * ArcGIS World Imagery tiles carry Access-Control-Allow-Origin: * so
 * canvas.toDataURL() is safe after drawing them.
 */

const TILE_SIZE = 256;
const OUT_W = 800;
const OUT_H = 460;
const TILE_TIMEOUT_MS = 8_000;

export interface LatLng { lat: number; lng: number }

// ── Tile URL ──────────────────────────────────────────────────────────────────
function esriTile(z: number, y: number, x: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

// ── Projection helpers ────────────────────────────────────────────────────────
function lngLatToWorldPx(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

// ── Zoom selection ────────────────────────────────────────────────────────────
function pickZoom(
  minLat: number, maxLat: number,
  minLng: number, maxLng: number,
): number {
  const PAD = 1.5; // multiplier — add breathing room around bounds
  for (let z = 17; z >= 3; z--) {
    const tl = lngLatToWorldPx(maxLat, minLng, z);
    const br = lngLatToWorldPx(minLat, maxLng, z);
    const spanX = (br.x - tl.x) * PAD;
    const spanY = (br.y - tl.y) * PAD;
    if (spanX <= OUT_W && spanY <= OUT_H) return z;
  }
  return 3;
}

// ── Tile loader with timeout and CORS ────────────────────────────────────────
function loadTile(z: number, ty: number, tx: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => resolve(null), TILE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timeout); resolve(img); };
    img.onerror = () => { clearTimeout(timeout); resolve(null); };
    img.src = esriTile(z, ty, tx);
  });
}

// ── Scale-bar helper ──────────────────────────────────────────────────────────
function scaleBar(centLat: number, zoom: number): { px: number; label: string } {
  const metersPerPx = (156543.03392 * Math.cos((centLat * Math.PI) / 180)) / Math.pow(2, zoom);
  const targets = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
  for (const m of targets) {
    const px = m / metersPerPx;
    if (px >= 60 && px <= 200) {
      const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
      return { px, label };
    }
  }
  return { px: 80, label: '—' };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateSatellitePreview(
  boundary: LatLng[],
  projectName: string,
  areaHa: number,
): Promise<string | null> {
  if (!boundary || boundary.length < 3) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Bounds
    const lats = boundary.map((p) => p.lat);
    const lngs = boundary.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const centLat = (minLat + maxLat) / 2;
    const centLng = (minLng + maxLng) / 2;

    const zoom = pickZoom(minLat, maxLat, minLng, maxLng);

    // World-pixel centre
    const centre = lngLatToWorldPx(centLat, centLng, zoom);
    const originX = centre.x - OUT_W / 2;
    const originY = centre.y - OUT_H / 2;

    // Tile range
    const tileMinX = Math.floor(originX / TILE_SIZE);
    const tileMaxX = Math.floor((originX + OUT_W) / TILE_SIZE);
    const tileMinY = Math.floor(originY / TILE_SIZE);
    const tileMaxY = Math.floor((originY + OUT_H) / TILE_SIZE);
    const tileCount = Math.pow(2, zoom);

    // Draw tiles
    ctx.fillStyle = '#1a2035';
    ctx.fillRect(0, 0, OUT_W, OUT_H);

    const tilePromises: Promise<void>[] = [];
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      for (let tx = tileMinX; tx <= tileMaxX; tx++) {
        const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
        const tileY = ty;
        const drawX = tx * TILE_SIZE - originX;
        const drawY = tileY * TILE_SIZE - originY;
        tilePromises.push(
          loadTile(zoom, tileY, wrappedX).then((img) => {
            if (img) {
              ctx.drawImage(img, Math.round(drawX), Math.round(drawY), TILE_SIZE, TILE_SIZE);
            } else {
              ctx.fillStyle = '#1e2d3e';
              ctx.fillRect(Math.round(drawX), Math.round(drawY), TILE_SIZE, TILE_SIZE);
            }
          }),
        );
      }
    }
    await Promise.all(tilePromises);

    // Convert boundary lat/lng → canvas px
    const toCanvasPx = (lat: number, lng: number) => {
      const wp = lngLatToWorldPx(lat, lng, zoom);
      return { x: wp.x - originX, y: wp.y - originY };
    };

    const pts = boundary.map((p) => toCanvasPx(p.lat, p.lng));

    // Polygon fill (semi-transparent teal)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,184,166,0.18)';
    ctx.fill();

    // Polygon stroke
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#14b8a6';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Vertex dots
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#14b8a6';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ── Top label bar ─────────────────────────────────────────────────────────
    const topH = 40;
    const topGrad = ctx.createLinearGradient(0, 0, 0, topH);
    topGrad.addColorStop(0, 'rgba(0,0,0,0.78)');
    topGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, OUT_W, topH);

    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('PROJECT BOUNDARY PREVIEW', 14, 17);

    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#5eead4';
    const truncName = projectName.length > 55 ? projectName.slice(0, 52) + '…' : projectName;
    ctx.fillText(truncName, 14, 33);

    // ── Bottom info bar ───────────────────────────────────────────────────────
    const botH = 44;
    const botGrad = ctx.createLinearGradient(0, OUT_H - botH, 0, OUT_H);
    botGrad.addColorStop(0, 'rgba(0,0,0,0)');
    botGrad.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, OUT_H - botH, OUT_W, botH);

    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#5eead4';
    ctx.fillText(`${areaHa.toFixed(2)} ha`, 14, OUT_H - 24);

    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`${centLat.toFixed(5)}°, ${centLng.toFixed(5)}°`, 14, OUT_H - 10);

    // Attribution
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const attr = '© Esri, Maxar, Earthstar Geographics';
    const attrW = ctx.measureText(attr).width;
    ctx.fillText(attr, OUT_W - attrW - 8, OUT_H - 6);

    // ── North arrow ───────────────────────────────────────────────────────────
    const ax = OUT_W - 28, ay = 52;
    ctx.beginPath();
    ctx.moveTo(ax, ay - 18);
    ctx.lineTo(ax + 7, ay + 2);
    ctx.lineTo(ax, ay - 4);
    ctx.closePath();
    ctx.fillStyle = '#14b8a6';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ax, ay - 18);
    ctx.lineTo(ax - 7, ay + 2);
    ctx.lineTo(ax, ay - 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.font = 'bold 9px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText('N', ax, ay + 14);
    ctx.textAlign = 'left';

    // ── Scale bar ─────────────────────────────────────────────────────────────
    const sb = scaleBar(centLat, zoom);
    const sbX = 14, sbY = OUT_H - botH - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(sbX - 2, sbY - 10, sb.px + 4, 14);
    ctx.fillStyle = 'white';
    ctx.fillRect(sbX, sbY - 8, sb.px / 2, 6);
    ctx.fillStyle = '#14b8a6';
    ctx.fillRect(sbX + sb.px / 2, sbY - 8, sb.px / 2, 6);
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(sb.label, sbX + sb.px / 2 - ctx.measureText(sb.label).width / 2, sbY + 3);

    return canvas.toDataURL('image/png');
  } catch (err) {
    return null; // Preview is non-critical; caller shows a placeholder instead
  }
}
