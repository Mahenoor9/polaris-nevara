import type { NormalizedPolygon } from "./polygon-ingestion";
import { computeSpatialMetrics } from "./spatial-service";

export interface PolygonValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const VALIDATION_RULES = {
  minAreaHectares: 0.5,
  maxAreaHectares: 50000,
  minVertices: 4,
  maxVertices: 10000,
  latitudeMin: -60,
  latitudeMax: 75,
  longitudeMin: -180,
  longitudeMax: 180,
};

export function validatePolygonGeometry(polygon: NormalizedPolygon): PolygonValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ring = polygon.coordinates[0] ?? [];

  if (polygon.type !== "Polygon") {
    errors.push("Geometry must be Polygon type.");
  }

  if (ring.length < VALIDATION_RULES.minVertices) {
    errors.push(`Polygon requires at least ${VALIDATION_RULES.minVertices - 1} vertices.`);
  }

  if (ring.length > VALIDATION_RULES.maxVertices) {
    errors.push(`Polygon exceeds maximum vertex count (${VALIDATION_RULES.maxVertices}).`);
  }

  if (ring.length > 1) {
    const [startLng, startLat] = ring[0];
    const [endLng, endLat] = ring[ring.length - 1];
    if (startLng !== endLng || startLat !== endLat) {
      errors.push("Polygon ring must be closed.");
    }
  }

  for (const [lng, lat] of ring) {
    if (lat < VALIDATION_RULES.latitudeMin || lat > VALIDATION_RULES.latitudeMax) {
      errors.push("Polygon extends beyond supported latitude range.");
      break;
    }
    if (lng < VALIDATION_RULES.longitudeMin || lng > VALIDATION_RULES.longitudeMax) {
      errors.push("Polygon extends beyond supported longitude range.");
      break;
    }
  }

  if (errors.length === 0) {
    const metrics = computeSpatialMetrics(polygon);
    if (metrics.areaHectares < VALIDATION_RULES.minAreaHectares) {
      errors.push("Polygon area below minimum supported threshold.");
    }
    if (metrics.areaHectares > VALIDATION_RULES.maxAreaHectares) {
      errors.push("Polygon area exceeds maximum supported threshold.");
    }
    if (metrics.areaHectares < 1) {
      warnings.push("Polygon area is very small; data quality may degrade.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

