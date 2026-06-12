type CoordinatePair = [number, number];

export interface NormalizedPolygon {
  type: "Polygon";
  coordinates: CoordinatePair[][];
}

export interface PolygonIngestionResult {
  polygon: NormalizedPolygon;
  geojsonText: string;
  warnings: string[];
}

function isObjectCoordinate(value: unknown): value is { lat: number; lng: number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { lat?: unknown; lng?: unknown };
  return typeof candidate.lat === "number" && typeof candidate.lng === "number";
}

function normalizePair(pair: unknown): CoordinatePair | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const first = Number(pair[0]);
  const second = Number(pair[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

  const firstLooksLat = Math.abs(first) <= 90;
  const secondLooksLng = Math.abs(second) <= 180;

  if (firstLooksLat && secondLooksLng) {
    return [second, first];
  }

  return [first, second];
}

function closeRingIfNeeded(ring: CoordinatePair[]): CoordinatePair[] {
  if (ring.length === 0) return ring;
  const [startLng, startLat] = ring[0];
  const [endLng, endLat] = ring[ring.length - 1];
  if (startLng === endLng && startLat === endLat) return ring;
  return [...ring, [startLng, startLat]];
}

export function parsePolygonFromLandBoundary(rawBoundary: string): PolygonIngestionResult {
  const parsed = JSON.parse(rawBoundary) as unknown;
  const warnings: string[] = [];
  let ring: CoordinatePair[] = [];  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    let geojson = parsed as any;
    if (geojson.type === "Feature" && geojson.geometry && typeof geojson.geometry === "object") {
      geojson = geojson.geometry;
    }
    if (geojson.type === "Polygon" && Array.isArray(geojson.coordinates)) {
      const firstRing = geojson.coordinates[0];
      if (Array.isArray(firstRing)) {
        ring = firstRing
          .map((point) => normalizePair(point))
          .filter((point): point is CoordinatePair => point !== null);
      }
    }
  }
  if (ring.length === 0 && Array.isArray(parsed)) {
    if (parsed.length > 0 && isObjectCoordinate(parsed[0])) {
      ring = parsed.map((point) => [point.lng, point.lat]);
      warnings.push("Converted polygon coordinates from object format.");
    } else {
      ring = parsed
        .map((point) => normalizePair(point))
        .filter((point): point is CoordinatePair => point !== null);
    }
  }

  if (ring.length < 3) {
    throw new Error("Polygon ingestion failed: at least 3 valid vertices required.");
  }

  ring = closeRingIfNeeded(ring);
  const polygon: NormalizedPolygon = {
    type: "Polygon",
    coordinates: [ring],
  };

  return {
    polygon,
    geojsonText: JSON.stringify(polygon),
    warnings,
  };
}

