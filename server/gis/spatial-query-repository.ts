import { sql } from "drizzle-orm";
import { isDatabaseModeEnabled } from "../db";

export interface NearbyProject {
  id: string;
  name: string;
  registryId: string | null;
  distanceKm: number;
}

export interface OverlapProject {
  id: string;
  name: string;
  registryId: string | null;
  overlapHectares: number;
}
interface SpatialMetricsRow {
  areaHectares: number;
  centroidLng: number;
  centroidLat: number;
}

export class SpatialQueryRepository {
  private async db() {
    const { db } = await import("../db");
    return db;
  }

  async findProjectsNear(lat: number, lng: number, radiusKm: number): Promise<NearbyProject[]> {
    if (!isDatabaseModeEnabled()) return [];
    const db = await this.db();
    const result = await db.execute(sql`
      SELECT
        id,
        name,
        registry_id AS "registryId",
        ST_Distance(
          centroid::geography,
          ST_SetSRID(ST_Point(${lng}, ${lat}), 4326)::geography
        ) / 1000 AS "distanceKm"
      FROM public.projects
      WHERE centroid IS NOT NULL
        AND ST_DWithin(
          centroid::geography,
          ST_SetSRID(ST_Point(${lng}, ${lat}), 4326)::geography,
          ${radiusKm * 1000}
        )
      ORDER BY "distanceKm" ASC
      LIMIT 100
    `);

    return ((result.rows ?? []) as unknown as NearbyProject[]);
  }

  async checkOverlap(geojsonPolygonText: string): Promise<OverlapProject[]> {
    if (!isDatabaseModeEnabled()) return [];
    const db = await this.db();
    const result = await db.execute(sql`
      WITH input_geom AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojsonPolygonText}), 4326) AS geom
      )
      SELECT
        id,
        name,
        registry_id AS "registryId",
        ST_Area(
          ST_Intersection(
            polygon,
            input_geom.geom
          )::geography
        ) / 10000 AS "overlapHectares"
      FROM public.projects, input_geom
      WHERE polygon IS NOT NULL
        AND ST_Intersects(polygon, input_geom.geom)
        AND archived_at IS NULL
      ORDER BY "overlapHectares" DESC
    `);

    return ((result.rows ?? []) as unknown as OverlapProject[]);
  }

  async computeSpatialMetrics(geojsonPolygonText: string): Promise<{
    areaHectares: number;
    centroidLng: number;
    centroidLat: number;
  }> {
    if (!isDatabaseModeEnabled()) return { areaHectares: 0, centroidLng: 0, centroidLat: 0 };
    const db = await this.db();
    const result = await db.execute(sql`
      WITH input_geom AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojsonPolygonText}), 4326) AS geom
      )
      SELECT
        ST_Area(input_geom.geom::geography) / 10000 AS "areaHectares",
        ST_X(ST_Centroid(input_geom.geom)) AS "centroidLng",
        ST_Y(ST_Centroid(input_geom.geom)) AS "centroidLat"
      FROM input_geom
    `);

    return ((result.rows?.[0] as unknown as SpatialMetricsRow | undefined) ?? {
      areaHectares: 0,
      centroidLng: 0,
      centroidLat: 0,
    });
  }
}

export const spatialQueryRepository = new SpatialQueryRepository();
