/**
 * GIS Enrichment Service
 *
 * Computes authoritative spatial metrics from a parsed polygon using @turf/turf:
 *  - areaHectares: geodesic area via turf.area()
 *  - perimeterKm:  ring length via turf.length()
 *  - centroid:     { lat, lng } via turf.centroid()
 *  - bbox:         [minLng, minLat, maxLng, maxLat] via turf.bbox()
 *
 * Then attempts a free reverse-geocode via Nominatim (no API key required) to derive:
 *  - country, adminRegion (state/province), city, displayLocation
 *
 * If geocoding fails or times out, falls back to coordinate string.
 * No external service is required for the spatial math — only Nominatim for geocoding.
 */

import * as turf from "@turf/turf";
import type { NormalizedPolygon } from "./polygon-ingestion";

export interface GisEnrichmentResult {
  /** Geodesic area in hectares (authoritative — use this, not user-supplied area) */
  areaHectares: number;
  /** Polygon perimeter in kilometres */
  perimeterKm: number;
  /** Centroid lat/lng */
  centroid: { lat: number; lng: number };
  /** Bounding box [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  /** Human-readable location string (geocoded or coordinate fallback) */
  location: string;
  /** ISO 3166-1 country name, if geocoded */
  country: string | null;
  /** State / province / administrative region, if geocoded */
  adminRegion: string | null;
  /** City or village, if geocoded */
  city: string | null;
}

// Nominatim reverse-geocode endpoint (free, no key, 1 req/s fair-use limit)
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const GEOCODE_TIMEOUT_MS = 6_000;

/**
 * Compute all spatial metrics from a normalised polygon.
 * Pure turf — synchronous, no network calls.
 */
export function computeMetrics(polygon: NormalizedPolygon): Omit<
  GisEnrichmentResult,
  "location" | "country" | "adminRegion" | "city"
> {
  const turfPoly = turf.polygon(polygon.coordinates as number[][][]);
  const areaSqM = turf.area(turfPoly);
  const perimeterKm = turf.length(turf.polygonToLine(turfPoly), {
    units: "kilometers",
  });
  const centroidCoords = turf.centroid(turfPoly).geometry.coordinates;
  const bbox = turf.bbox(turfPoly) as [number, number, number, number];

  return {
    areaHectares: Number((areaSqM / 10000).toFixed(4)),
    perimeterKm: Number(perimeterKm.toFixed(4)),
    centroid: {
      lng: Number(centroidCoords[0].toFixed(7)),
      lat: Number(centroidCoords[1].toFixed(7)),
    },
    bbox,
  };
}

/**
 * Attempt a Nominatim reverse-geocode for the centroid.
 * Returns partial geocode fields on success, nulls on failure.
 */
async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ country: string | null; adminRegion: string | null; city: string | null; displayName: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lon", lng.toFixed(6));
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "10");

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        // Nominatim requires a valid User-Agent
        "User-Agent": "NEVARA-MRV-Platform/2.0 (contact@nevara.earth)",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[GIS] [Geocoding] Nominatim returned ${response.status}`);
      return { country: null, adminRegion: null, city: null, displayName: null };
    }

    const data: any = await response.json();
    const address = data?.address ?? {};

    const country = address.country ?? null;
    const adminRegion =
      address.state ??
      address.province ??
      address.region ??
      address.county ??
      null;
    const city =
      address.city ??
      address.town ??
      address.village ??
      address.hamlet ??
      address.suburb ??
      null;
    const displayName = data?.display_name ?? null;

    console.log(`[GIS] [Geocoding] Resolved: city=${city}, adminRegion=${adminRegion}, country=${country}`);
    return { country, adminRegion, city, displayName };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[GIS] [Geocoding] Nominatim request timed out — using coordinate fallback");
    } else {
      console.warn("[GIS] [Geocoding] Nominatim request failed:", err?.message ?? err);
    }
    return { country: null, adminRegion: null, city: null, displayName: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full enrichment pipeline:
 * 1. Compute turf spatial metrics (synchronous)
 * 2. Attempt reverse geocode (async, tolerates failure)
 * 3. Build a human-readable location string
 */
export async function enrichPolygon(
  polygon: NormalizedPolygon
): Promise<GisEnrichmentResult> {
  const metrics = computeMetrics(polygon);
  const { centroid } = metrics;

  console.log(
    `[GIS] [Enrichment] Polygon: area=${metrics.areaHectares} ha, perimeter=${metrics.perimeterKm} km, centroid=(${centroid.lat}, ${centroid.lng})`
  );

  const geocode = await reverseGeocode(centroid.lat, centroid.lng);

  // Build the best possible location string
  let location: string;
  if (geocode.city && geocode.country) {
    location = [geocode.city, geocode.adminRegion, geocode.country]
      .filter(Boolean)
      .join(", ");
  } else if (geocode.adminRegion && geocode.country) {
    location = [geocode.adminRegion, geocode.country].filter(Boolean).join(", ");
  } else if (geocode.country) {
    location = geocode.country;
  } else if (geocode.displayName) {
    // Trim the display name to something reasonable
    location = geocode.displayName.split(",").slice(0, 3).join(",").trim();
  } else {
    // Fallback to coordinates — always informative
    location = `${centroid.lat.toFixed(4)}°, ${centroid.lng.toFixed(4)}°`;
  }

  return {
    ...metrics,
    location,
    country: geocode.country,
    adminRegion: geocode.adminRegion,
    city: geocode.city,
  };
}

export const gisEnrichmentService = {
  computeMetrics,
  enrichPolygon,
};
