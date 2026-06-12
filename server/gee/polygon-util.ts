/**
 * Polygon normaliser for Earth Engine geometry construction.
 *
 * Project polygons flow through the pipeline as a GeoJSON-like object
 * `{ type: "Polygon", coordinates: [ring] }` (see polygon-ingestion.ts), but
 * `ee.Geometry.Polygon()` expects the *coordinates list* (a list of rings),
 * not the wrapper object. Passing the wrapper triggers EE "Assertion failed".
 *
 * This helper accepts either form and always returns a coordinates list that
 * `ee.Geometry.Polygon()` accepts.
 */
export function toEePolygonCoords(polygon: any): any {
  if (polygon && typeof polygon === "object" && !Array.isArray(polygon) && Array.isArray(polygon.coordinates)) {
    return polygon.coordinates; // GeoJSON Polygon → list of rings
  }
  return polygon; // already a coordinate list (ring or list of rings)
}

/** Flatten any nested coordinate structure (or GeoJSON polygon) into [lng,lat] pairs. */
export function flattenLngLat(polygon: any): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (node: any) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      out.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(toEePolygonCoords(polygon));
  return out;
}
