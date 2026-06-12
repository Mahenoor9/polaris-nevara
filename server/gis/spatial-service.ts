import * as turf from "@turf/turf";
import type { Project } from "@shared/schema";
import type { NormalizedPolygon } from "./polygon-ingestion";
import { parsePolygonFromLandBoundary } from "./polygon-ingestion";

export interface SpatialMetrics {
  areaHectares: number;
  perimeterKm: number;
  centroid: { lat: number; lng: number };
  bbox: [number, number, number, number];
}

export interface SpatialOverlapResult {
  overlaps: boolean;
  overlapProjectName?: string;
}

export interface EcosystemDetectionHookPayload {
  projectId: string;
  polygon: NormalizedPolygon;
  landCoverPreparation: {
    datasets: string[];
    resolutionMeters: number;
    classificationTargets: string[];
  };
  waterbodyPreparation: {
    providers: string[];
    searchRadiusMeters: number;
    centroid: { lat: number; lng: number };
  };
}

function toTurfPolygon(polygon: NormalizedPolygon) {
  return turf.polygon(polygon.coordinates as number[][][]);
}

export function computeSpatialMetrics(polygon: NormalizedPolygon): SpatialMetrics {
  const turfPolygon = toTurfPolygon(polygon);
  const areaSqMeters = turf.area(turfPolygon);
  const perimeterKm = turf.length(turf.polygonToLine(turfPolygon), { units: "kilometers" });
  const centroid = turf.centroid(turfPolygon).geometry.coordinates;
  const bbox = turf.bbox(turfPolygon) as [number, number, number, number];

  return {
    areaHectares: Number((areaSqMeters / 10000).toFixed(4)),
    perimeterKm: Number(perimeterKm.toFixed(4)),
    centroid: {
      lng: Number(centroid[0].toFixed(7)),
      lat: Number(centroid[1].toFixed(7)),
    },
    bbox,
  };
}

export function detectOverlapWithProjects(
  polygon: NormalizedPolygon,
  existingProjects: Project[],
): SpatialOverlapResult {
  const incoming = toTurfPolygon(polygon);

  for (const project of existingProjects) {
    if (project.status !== "verified" || !project.landBoundary) continue;
    try {
      const existingPolygon = parsePolygonFromLandBoundary(project.landBoundary).polygon;
      if (turf.booleanIntersects(incoming, toTurfPolygon(existingPolygon))) {
        return { overlaps: true, overlapProjectName: project.name };
      }
    } catch {
      continue;
    }
  }

  return { overlaps: false };
}

export function prepareLandCoverClassification(): EcosystemDetectionHookPayload["landCoverPreparation"] {
  return {
    datasets: ["ESA/WorldCover/v200", "GOOGLE/DYNAMICWORLD/V1"],
    resolutionMeters: 10,
    classificationTargets: ["tree", "grass", "crop", "water", "wetland", "bare", "built"],
  };
}

export function prepareWaterbodyDetection(centroid: { lat: number; lng: number }): EcosystemDetectionHookPayload["waterbodyPreparation"] {
  return {
    providers: ["JRC/GSW1_4/GlobalSurfaceWater", "OpenStreetMap/Overpass"],
    searchRadiusMeters: 5000,
    centroid,
  };
}

export function buildEcosystemDetectionHookPayload(
  projectId: string,
  polygon: NormalizedPolygon,
): EcosystemDetectionHookPayload {
  const metrics = computeSpatialMetrics(polygon);
  return {
    projectId,
    polygon,
    landCoverPreparation: prepareLandCoverClassification(),
    waterbodyPreparation: prepareWaterbodyDetection(metrics.centroid),
  };
}

export function deriveInitialEcosystemType(
  declaredEcosystemType: string,
  landCoverComposition: Record<string, number>,
): string {
  if (landCoverComposition.wetland && landCoverComposition.wetland > 35) return "wetland";
  if (landCoverComposition.water && landCoverComposition.water > 30) return "lake";
  if (landCoverComposition.tree && landCoverComposition.tree > 40) return "forest";
  return declaredEcosystemType?.toLowerCase() || "other";
}

