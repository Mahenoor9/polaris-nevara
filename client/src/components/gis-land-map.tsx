import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import 'leaflet-draw';
import { MapPin, Trash2, Search, X, Loader2, Layers, ChevronDown } from 'lucide-react';

// Fix default marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// leaflet-draw v1.0.4 bug: L.GeometryUtil.readableArea assigns to an undeclared `type`
// variable (missing `var`). In Vite's strict-mode ES module context this throws
// ReferenceError: type is not defined on the 3rd polygon vertex when showArea:true
// triggers geodesicArea → _getMeasurementString → readableArea.
(function patchLeafletDrawGeometryUtil() {
  const gu = (L as any).GeometryUtil;
  if (!gu || typeof gu.readableArea !== 'function') return;
  gu.readableArea = function readableAreaPatched(area: number, isMetric: any, precision: any) {
    const defaultPrecision = { km: 2, ha: 2, m: 0, mi: 2, ac: 2, yd: 0, ft: 0, nm: 2 };
    const prec = Object.assign({}, defaultPrecision, precision);
    let areaStr: string;
    let units: string[];
    var type: string; // the missing declaration that caused ReferenceError
    if (isMetric) {
      units = ['ha', 'm'];
      type = typeof isMetric;
      if (type === 'string') { units = [isMetric]; }
      else if (type !== 'boolean') { units = isMetric; }
      if (area >= 1000000 && units.indexOf('km') !== -1)
        areaStr = (L as any).GeometryUtil.formattedNumber(area * 0.000001, prec['km']) + ' km²';
      else if (area >= 10000 && units.indexOf('ha') !== -1)
        areaStr = (L as any).GeometryUtil.formattedNumber(area * 0.0001, prec['ha']) + ' ha';
      else
        areaStr = (L as any).GeometryUtil.formattedNumber(area, prec['m']) + ' m²';
    } else {
      area /= 0.836127;
      if (area >= 3097600) areaStr = (L as any).GeometryUtil.formattedNumber(area / 3097600, prec['mi']) + ' mi²';
      else if (area >= 4840) areaStr = (L as any).GeometryUtil.formattedNumber(area / 4840, prec['ac']) + ' ac';
      else areaStr = (L as any).GeometryUtil.formattedNumber(area, prec['yd']) + ' yd²';
    }
    return areaStr;
  };
})();

// ── Basemap definitions ────────────────────────────────────────────────────────
type BasemapId = 'satellite' | 'street' | 'terrain' | 'dark';

const BASEMAPS: Record<BasemapId, {
  label: string; url: string; attribution: string;
  subdomains?: string; maxZoom: number; maxNativeZoom: number;
  icon: string;
}> = {
  satellite: {
    label: 'Satellite',
    icon: '🛰',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS User Community',
    maxZoom: 20,
    maxNativeZoom: 19,
  },
  street: {
    label: 'Street',
    icon: '🗺',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
    maxNativeZoom: 19,
  },
  terrain: {
    label: 'Terrain',
    icon: '🏔',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    subdomains: 'abc',
    maxZoom: 17,
    maxNativeZoom: 17,
  },
  dark: {
    label: 'Dark',
    icon: '🌑',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
    maxNativeZoom: 19,
  },
};

// Transparent Esri labels overlay — used on satellite for hybrid experience
const ESRI_LABELS_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

function createTileLayer(id: BasemapId): L.TileLayer {
  const cfg = BASEMAPS[id];
  const opts: L.TileLayerOptions = {
    attribution: cfg.attribution,
    maxZoom: cfg.maxZoom,
    maxNativeZoom: cfg.maxNativeZoom,
    // Graceful fallback: show last available tile instead of blank above native zoom
    keepBuffer: 4,
  };
  if (cfg.subdomains) opts.subdomains = cfg.subdomains;
  return L.tileLayer(cfg.url, opts);
}

function createLabelsLayer(): L.TileLayer {
  return L.tileLayer(ESRI_LABELS_URL, {
    attribution: '',
    maxZoom: 20,
    maxNativeZoom: 19,
    opacity: 1,
    pane: 'shadowPane', // renders above tiles but below markers
  });
}

// ── Geometry helpers ──────────────────────────────────────────────────────────
interface LatLng { lat: number; lng: number }

function calculatePolygonArea(coords: LatLng[]): number {
  if (!Array.isArray(coords) || coords.length < 3) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  let total = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = toRad(coords[i].lng), yi = toRad(coords[i].lat);
    const xj = toRad(coords[j].lng), yj = toRad(coords[j].lat);
    total += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
  }
  return Math.round((Math.abs((total * R * R) / 2) / 10000) * 100) / 100;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function calculatePerimeterKm(coords: LatLng[]): number {
  if (coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length; i++) total += haversineKm(coords[i], coords[(i + 1) % coords.length]);
  return Math.round(total * 100) / 100;
}

function getCentroid(coords: LatLng[]): LatLng {
  if (!coords.length) return { lat: 0, lng: 0 };
  return {
    lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
    lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
  };
}

// ── Geocoding ─────────────────────────────────────────────────────────────────
interface GeoResult { lat: number; lng: number; displayName: string }

async function geocodeQuery(query: string): Promise<GeoResult | null> {
  const q = query.trim();
  if (!q) return null;
  const coordMatch = q.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
      return { lat, lng, displayName: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'NEVARA-MRV-Platform/1.0' } },
    );
    const data = await res.json();
    if (!data?.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
  } catch {
    return null;
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface GISLandMapProps {
  onBoundaryChange: (boundary: LatLng[], area: number) => void;
  initialBoundary?: LatLng[];
  readOnly?: boolean;
  className?: string;
  ndviTileUrl?: string | null;
  ndviPolygon?: LatLng[] | null;
  overlayTileUrls?: Record<string, string | null | undefined>;
}

// ── Leaflet style overrides injected once ─────────────────────────────────────
const LEAFLET_STYLE_ID = 'nevara-leaflet-overrides';
function injectLeafletStyles() {
  if (document.getElementById(LEAFLET_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = LEAFLET_STYLE_ID;
  style.textContent = `
    .leaflet-control-zoom a {
      width: 28px !important; height: 28px !important; line-height: 28px !important;
      font-size: 16px !important; border-radius: 6px !important;
      background: rgba(15,23,42,0.85) !important; color: #e2e8f0 !important;
      border: 1px solid rgba(255,255,255,0.10) !important;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3) !important;
      backdrop-filter: blur(8px) !important;
    }
    .leaflet-control-zoom a:hover {
      background: rgba(16,185,129,0.25) !important; color: #34d399 !important;
    }
    .leaflet-control-zoom {
      border: none !important; box-shadow: none !important;
      display: flex !important; flex-direction: column !important; gap: 3px !important;
    }
    .leaflet-control-attribution {
      background: rgba(0,0,0,0.45) !important; backdrop-filter: blur(6px) !important;
      color: rgba(255,255,255,0.35) !important; font-size: 8px !important;
      padding: 1px 5px !important; border-radius: 4px 0 0 0 !important;
      max-width: 220px !important; white-space: nowrap !important;
      overflow: hidden !important; text-overflow: ellipsis !important;
      letter-spacing: 0.02em !important;
    }
    .leaflet-control-attribution a { color: rgba(52,211,153,0.55) !important; }
    .leaflet-draw-toolbar a {
      background-color: rgba(15,23,42,0.88) !important; color: #94a3b8 !important;
      border-color: rgba(255,255,255,0.10) !important; backdrop-filter: blur(8px) !important;
    }
    .leaflet-draw-toolbar a:hover { color: #34d399 !important; background: rgba(16,185,129,0.2) !important; }
    .leaflet-bar { box-shadow: none !important; border: none !important; }
    .leaflet-draw-section { border-bottom: none !important; }
  `;
  document.head.appendChild(style);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GISLandMap({
  onBoundaryChange, initialBoundary, readOnly = false, className = '',
  ndviTileUrl, ndviPolygon, overlayTileUrls,
}: GISLandMapProps) {
  const [boundary, setBoundary] = useState<LatLng[]>(initialBoundary ?? []);
  const [area, setArea] = useState<number>(0);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mapType, setMapType] = useState<BasemapId>('satellite');
  const [showLabels, setShowLabels] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(0.75);
  const [enabledOverlays, setEnabledOverlays] = useState<Record<string, boolean>>({ ndvi_latest: true });
  const [drawVertexCount, setDrawVertexCount] = useState(0);
  const [guidanceCollapsed, setGuidanceCollapsed] = useState(false);
  const [layerDropdownOpen, setLayerDropdownOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<GeoResult | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layerDropdownRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const labelsLayerRef = useRef<L.TileLayer | null>(null);
  const drawnLayerRef = useRef<L.FeatureGroup | null>(null);
  const ndviLayerRef = useRef<L.TileLayer | null>(null);
  const overlayLayerRefs = useRef<Record<string, L.TileLayer>>({});
  const ndviPolygonLayerRef = useRef<L.Polygon | null>(null);
  const searchMarkerRef = useRef<L.Marker | null>(null);
  const isInitializedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const onBoundaryChangeRef = useRef(onBoundaryChange);
  const mapTypeRef = useRef<BasemapId>(mapType);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialBoundaryRef = useRef(initialBoundary);

  useEffect(() => { onBoundaryChangeRef.current = onBoundaryChange; }, [onBoundaryChange]);
  useEffect(() => { mapTypeRef.current = mapType; }, [mapType]);

  useEffect(() => {
    if (initialBoundary && Array.isArray(initialBoundary) && initialBoundary.length > 0) {
      setBoundary(initialBoundary);
      setArea(calculatePolygonArea(initialBoundary));
    }
  }, [initialBoundary]);

  // Close layer dropdown when clicking outside
  useEffect(() => {
    if (!layerDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (layerDropdownRef.current && !layerDropdownRef.current.contains(e.target as Node)) {
        setLayerDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [layerDropdownOpen]);

  // ── Map initialization ──────────────────────────────────────────────────────
  useEffect(() => {
    injectLeafletStyles();
    let isMounted = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const initMap = () => {
      if (!isMounted || !mapContainerRef.current || isInitializedRef.current) return;
      const rect = mapContainerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      isInitializedRef.current = true;

      const map = L.map(mapContainerRef.current, {
        center: [0, 20],
        zoom: 3,
        minZoom: 3,
        maxZoom: 20,
        scrollWheelZoom: true,
        preferCanvas: true,
        zoomControl: true,
      });

      map.zoomControl.setPosition('bottomright');

      const baseLayer = createTileLayer(mapTypeRef.current).addTo(map);
      tileLayerRef.current = baseLayer;

      const drawnItems = new L.FeatureGroup();
      map.addLayer(drawnItems);
      drawnLayerRef.current = drawnItems;
      mapRef.current = map;

      if (!readOnly) {
        const drawControl = new (L.Control as any).Draw({
          position: 'topright',
          draw: {
            polygon: {
              allowIntersection: false,
              showArea: false, // showArea:true triggers L.GeometryUtil.readableArea which has undeclared `type` bug in v1.0.4
              drawError: { color: '#ef4444', message: '<strong>Error:</strong> Boundary edges cannot cross.' },
              shapeOptions: { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, weight: 2.5 },
            },
            rectangle: false, circle: false, circlemarker: false, marker: false, polyline: false,
          },
          edit: false,
        });
        map.addControl(drawControl);

        map.on((L as any).Draw.Event.CREATED, (e: any) => {
          const layer = e.layer;
          drawnItems.clearLayers();
          drawnItems.addLayer(layer);
          const latLngsRing = layer.getLatLngs()[0];
          if (!latLngsRing) return;
          const coords = (latLngsRing as L.LatLng[]).map((ll) => ({ lat: ll.lat, lng: ll.lng }));
          setBoundary(coords);
          const a = calculatePolygonArea(coords);
          setArea(a);
          onBoundaryChangeRef.current(coords, a);
          setIsDrawing(false);
          setDrawVertexCount(0);
          setGuidanceCollapsed(true);
        });

        map.on((L as any).Draw.Event.DRAWSTART, () => { setIsDrawing(true); setDrawVertexCount(0); setGuidanceCollapsed(false); });
        map.on((L as any).Draw.Event.DRAWSTOP, () => setIsDrawing(false));
        map.on('draw:drawvertex', () => setDrawVertexCount((c) => c + 1));
      }

      if (initialBoundaryRef.current?.length) {
        const latLngs = initialBoundaryRef.current.map((p) => [p?.lat, p?.lng] as [number, number]);
        const polygon = L.polygon(latLngs, { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, weight: 2.5 });
        drawnItems.addLayer(polygon);
        setTimeout(() => {
          if (isMounted && mapRef.current) map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50] });
        }, 100);
      }

      setTimeout(() => { if (isMounted && mapRef.current) mapRef.current.invalidateSize(); }, 0);
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === mapContainerRef.current) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0 && !isInitializedRef.current) initMap();
          else if (width > 0 && height > 0 && mapRef.current)
            setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 100);
        }
      }
    });

    initMap();
    if (mapContainerRef.current) {
      observer.observe(mapContainerRef.current);
      resizeObserverRef.current = observer;
      const rect = mapContainerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) retryTimeout = setTimeout(initMap, 500);
    }

    return () => {
      isMounted = false;
      observer.disconnect();
      resizeObserverRef.current = null;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      isInitializedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // ── Basemap switching ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current) return;
    const map = mapRef.current;
    map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = createTileLayer(mapType).addTo(map);
  }, [mapType]);

  // ── Labels overlay — only on satellite when showLabels is on ───────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (labelsLayerRef.current) { map.removeLayer(labelsLayerRef.current); labelsLayerRef.current = null; }
    if (mapType === 'satellite' && showLabels) {
      labelsLayerRef.current = createLabelsLayer().addTo(map);
    }
  }, [mapType, showLabels]);

  // ── NDVI + overlay layers ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (ndviLayerRef.current) { map.removeLayer(ndviLayerRef.current); ndviLayerRef.current = null; }
    if (ndviPolygonLayerRef.current) { map.removeLayer(ndviPolygonLayerRef.current); ndviPolygonLayerRef.current = null; }

    if (ndviTileUrl && enabledOverlays.ndvi_latest !== false)
      ndviLayerRef.current = L.tileLayer(ndviTileUrl, { opacity: overlayOpacity, maxZoom: 20, crossOrigin: true }).addTo(map);

    for (const [k, l] of Object.entries(overlayLayerRefs.current)) { map.removeLayer(l); delete overlayLayerRefs.current[k]; }
    for (const [id, url] of Object.entries(overlayTileUrls ?? {})) {
      if (!url || !enabledOverlays[id]) continue;
      overlayLayerRefs.current[id] = L.tileLayer(url, { opacity: overlayOpacity, maxZoom: 20, crossOrigin: true }).addTo(map);
    }

    if (ndviPolygon?.length) {
      const latLngs = ndviPolygon.map((p) => [p.lat, p.lng] as [number, number]);
      ndviPolygonLayerRef.current = L.polygon(latLngs, { color: '#facc15', weight: 3, fillOpacity: 0.08, dashArray: '6 4' }).addTo(map);
      setTimeout(() => { if (mapRef.current) mapRef.current.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] }); }, 150);
    }
  }, [ndviTileUrl, ndviPolygon, overlayTileUrls, enabledOverlays, overlayOpacity]);

  // ── Search ─────────────────────────────────────────────────────────────────
  const executeSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResult(null);
    const result = await geocodeQuery(trimmed);
    setSearchLoading(false);
    if (!result) { setSearchError('Location not found. Try a city, district, or lat,lng.'); return; }
    setSearchResult(result);
    // Save to recent searches (session memory, max 5 unique)
    setRecentSearches((prev) => {
      const filtered = prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase());
      return [trimmed, ...filtered].slice(0, 5);
    });
    if (mapRef.current) {
      if (searchMarkerRef.current) { mapRef.current.removeLayer(searchMarkerRef.current); searchMarkerRef.current = null; }
      mapRef.current.flyTo([result.lat, result.lng], 13, { duration: 1.4 });
      searchMarkerRef.current = L.marker([result.lat, result.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:#10b981;border:2.5px solid white;border-radius:50%;width:14px;height:14px;box-shadow:0 2px 8px rgba(0,0,0,0.45)"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        }),
      }).addTo(mapRef.current);
    }
  }, []);

  const handleSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    executeSearch(searchQuery);
  }, [searchQuery, executeSearch]);

  // Debounce on query change
  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    setSearchError(null);
    if (!value.trim()) { setSearchResult(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => executeSearch(value), 380);
  }, [executeSearch]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchError(null);
    setSearchResult(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (mapRef.current && searchMarkerRef.current) {
      mapRef.current.removeLayer(searchMarkerRef.current);
      searchMarkerRef.current = null;
    }
  }, []);

  // ── Boundary / overlay controls ────────────────────────────────────────────
  const clearBoundary = useCallback(() => {
    if (drawnLayerRef.current) drawnLayerRef.current.clearLayers();
    setBoundary([]);
    setArea(0);
    setGuidanceCollapsed(false);
    onBoundaryChange([], 0);
  }, [onBoundaryChange]);

  const toggleOverlay = (id: string) => setEnabledOverlays((prev) => ({ ...prev, [id]: !prev[id] }));
  const availableOverlays = Object.keys(overlayTileUrls ?? {});

  const switchLayer = useCallback((id: BasemapId) => {
    setMapType(id);
    setLayerDropdownOpen(false);
  }, []);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const perimeter = boundary.length >= 3 ? calculatePerimeterKm(boundary) : 0;
  const centroid = boundary.length >= 3 ? getCentroid(boundary) : null;
  const hasBoundary = boundary.length >= 3;

  const drawingStep = !hasBoundary && !isDrawing ? 0
    : isDrawing && drawVertexCount === 0 ? 1
    : isDrawing && drawVertexCount > 0 ? 2
    : hasBoundary ? 4 : 0;

  const activeBasemap = BASEMAPS[mapType];
  const showRecentDropdown = searchFocused && !searchQuery && recentSearches.length > 0;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* ── Header row ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="w-4 h-4" />
          <span className="font-medium">{readOnly ? 'Boundary visualisation' : 'Define project boundary'}</span>
        </div>
        {!readOnly && hasBoundary && (
          <button
            type="button" onClick={clearBoundary}
            className="flex items-center gap-1.5 text-xs font-medium text-red-500 hover:text-red-600 transition-colors px-2 py-1 rounded-md hover:bg-red-50 dark:hover:bg-red-950/20"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear boundary
          </button>
        )}
      </div>

      {/* ── NDVI / overlay controls ── */}
      {(ndviTileUrl || availableOverlays.length > 0) && (
        <div className="rounded-lg border p-3 bg-muted/10 space-y-2">
          <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Raster Overlay Controls</p>
          <div className="flex flex-wrap gap-2">
            {ndviTileUrl && (
              <button type="button" onClick={() => toggleOverlay('ndvi_latest')}
                className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-colors ${enabledOverlays.ndvi_latest !== false ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-background text-muted-foreground border-border'}`}>
                NDVI Latest
              </button>
            )}
            {availableOverlays.map((id) => (
              <button key={id} type="button" onClick={() => toggleOverlay(id)}
                className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-colors ${enabledOverlays[id] ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-background text-muted-foreground border-border'}`}>
                {id.replaceAll('_', ' ')}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">Overlay opacity</span>
            <input type="range" min={0.2} max={1} step={0.05} value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(Number(e.target.value))} className="flex-1 max-w-40" />
            <span className="font-mono text-muted-foreground w-8">{Math.round(overlayOpacity * 100)}%</span>
          </div>
        </div>
      )}

      {/* ── Map container ── */}
      <div className="relative rounded-xl overflow-hidden border border-border/60 shadow-lg" style={{ height: '480px', zIndex: 0 }}>
        {/* Map div — Leaflet renders here */}
        <div ref={mapContainerRef} className="absolute inset-0" />

        {/* ── Search bar (top-left floating) ── */}
        {!readOnly && (
          <div className="absolute top-3 left-3 z-[1001] w-72">
            <div className={`flex items-center gap-1.5 bg-slate-900/92 backdrop-blur-md border rounded-lg shadow-xl px-2.5 py-1.5 transition-all duration-200 ${searchFocused ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-white/10'}`}>
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                placeholder="City, district, or lat, lng…"
                className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none min-w-0"
              />
              {searchLoading ? (
                <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
              ) : searchQuery ? (
                <div className="flex items-center gap-1">
                  <button type="button" onClick={handleSearch}
                    className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-900/30 hover:bg-emerald-900/50 transition-colors">
                    Go
                  </button>
                  <button type="button" onClick={clearSearch} className="text-slate-500 hover:text-slate-300 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : null}
            </div>

            {/* Recent searches dropdown */}
            {showRecentDropdown && (
              <div className="mt-1 bg-slate-900/95 border border-white/10 rounded-lg shadow-xl backdrop-blur-md overflow-hidden">
                <p className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">Recent</p>
                {recentSearches.map((s) => (
                  <button key={s} type="button"
                    onMouseDown={(e) => { e.preventDefault(); handleSearchInput(s); setTimeout(() => executeSearch(s), 0); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition-colors text-left"
                  >
                    <Search className="w-3 h-3 text-slate-500 shrink-0" />
                    <span className="truncate">{s}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Search error */}
            {searchError && (
              <div className="mt-1 px-3 py-1.5 bg-red-950/80 border border-red-800/40 rounded-lg text-xs text-red-300 backdrop-blur-md flex items-center gap-2">
                <X className="w-3 h-3 shrink-0" />{searchError}
              </div>
            )}

            {/* Search success */}
            {searchResult && !searchError && (
              <div className="mt-1 px-3 py-1.5 bg-slate-900/92 border border-emerald-500/20 rounded-lg text-xs text-slate-300 backdrop-blur-md truncate">
                <span className="text-emerald-400 font-semibold mr-1">✓</span>{searchResult.displayName}
              </div>
            )}
          </div>
        )}

        {/* ── Layer selector (top-right, below draw toolbar) ── */}
        {/* Positioned at top-[52px] to clear the Leaflet draw toolbar (~36px) at topright */}
        <div
          ref={layerDropdownRef}
          className="absolute z-[1001]"
          style={{ top: 52, right: 12 }}
        >
          {/* Collapsed trigger */}
          <button
            type="button"
            onClick={() => setLayerDropdownOpen((o) => !o)}
            className="flex items-center gap-1.5 bg-slate-900/92 backdrop-blur-md border border-white/10 rounded-lg shadow-xl px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white hover:border-white/20 transition-all duration-200 group"
          >
            <Layers className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-400 transition-colors shrink-0" />
            <span>{activeBasemap.icon} {activeBasemap.label}</span>
            <ChevronDown className={`w-3 h-3 text-slate-500 transition-transform duration-200 ${layerDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Expanded dropdown */}
          {layerDropdownOpen && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-slate-900/96 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden">
              {/* Layer options */}
              <div className="p-1">
                {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => switchLayer(id)}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs font-medium rounded-lg transition-all duration-150 ${
                      mapType === id
                        ? 'bg-emerald-600/70 text-white'
                        : 'text-slate-300 hover:bg-white/8 hover:text-white'
                    }`}
                  >
                    <span className="text-sm leading-none">{BASEMAPS[id].icon}</span>
                    <span>{BASEMAPS[id].label}</span>
                    {mapType === id && <span className="ml-auto text-emerald-300 text-[10px]">✓</span>}
                  </button>
                ))}
              </div>

              {/* Labels toggle — only available on satellite */}
              {mapType === 'satellite' && (
                <>
                  <div className="h-px bg-white/8 mx-2" />
                  <div className="p-1">
                    <button
                      type="button"
                      onClick={() => setShowLabels((v) => !v)}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium rounded-lg text-slate-300 hover:bg-white/8 hover:text-white transition-all duration-150"
                    >
                      <span className="text-sm leading-none">🏷</span>
                      <span>Place labels</span>
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${showLabels ? 'bg-emerald-600/50 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
                        {showLabels ? 'ON' : 'OFF'}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Drawing guidance card (bottom-left) ── */}
        {!readOnly && !guidanceCollapsed && (
          <div className="absolute bottom-10 left-3 z-[1000] w-52 bg-slate-900/92 backdrop-blur-md border border-white/10 rounded-xl shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Boundary Guide</span>
              {hasBoundary && (
                <button type="button" onClick={() => setGuidanceCollapsed(true)} className="text-slate-500 hover:text-slate-300 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="px-3 py-2.5 space-y-2">
              {[
                { step: 1, label: 'Search location', active: drawingStep === 0 },
                { step: 2, label: 'Zoom to project area', active: drawingStep === 0 },
                { step: 3, label: 'Click polygon tool →', active: drawingStep === 0 },
                { step: 4, label: `Place boundary points${isDrawing ? ` (${drawVertexCount})` : ''}`, active: isDrawing },
                { step: 5, label: hasBoundary ? 'Polygon complete ✓' : 'Click first point to close', active: hasBoundary },
              ].map(({ step, label, active }) => (
                <div key={step} className="flex items-center gap-2">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    (hasBoundary && step <= 5) || (isDrawing && step <= 4 && step >= 1)
                      ? 'bg-emerald-600 text-white'
                      : active
                      ? 'bg-emerald-500/30 text-emerald-400 ring-1 ring-emerald-500/50'
                      : 'bg-slate-800 text-slate-500'
                  }`}>
                    {hasBoundary && step < 5 ? '✓' : step}
                  </div>
                  <span className={`text-xs ${active ? 'text-white font-medium' : 'text-slate-500'}`}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── GIS stats card (bottom-right) ── */}
        {hasBoundary && (
          <div className="absolute bottom-10 right-3 z-[1000] w-52 bg-slate-900/92 backdrop-blur-md border border-white/10 rounded-xl shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10">
              <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">GIS Metrics</span>
            </div>
            <div className="px-3 py-2.5 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Area</span>
                <span className="font-mono font-bold text-white">{area.toLocaleString()} ha</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Perimeter</span>
                <span className="font-mono text-slate-200">{perimeter} km</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Vertices</span>
                <span className="font-mono text-slate-200">{boundary.length}</span>
              </div>
              {centroid && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Lat</span>
                    <span className="font-mono text-slate-200">{centroid.lat.toFixed(5)}°</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Lng</span>
                    <span className="font-mono text-slate-200">{centroid.lng.toFixed(5)}°</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Area summary below map ── */}
      {area > 0 && (
        <div className="flex items-center gap-4 rounded-lg border border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-3">
          <div>
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Calculated Area</p>
            <p className="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-0.5">
              {area.toLocaleString()} <span className="text-sm font-semibold">ha</span>
            </p>
          </div>
          {centroid && (
            <div className="ml-auto text-right">
              <p className="text-xs font-semibold text-emerald-600/70 dark:text-emerald-500/70 uppercase tracking-wide">Centroid</p>
              <p className="text-xs font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
                {centroid.lat.toFixed(5)}°, {centroid.lng.toFixed(5)}°
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Prompt when no boundary drawn ── */}
      {!readOnly && !hasBoundary && !isDrawing && (
        <div className="border border-dashed border-muted-foreground/20 rounded-lg p-4 text-center bg-muted/20">
          <p className="text-sm font-medium text-muted-foreground">
            Search for a location above, then use the <span className="font-bold text-foreground">polygon tool</span> in the top-right of the map to outline your project boundary.
          </p>
        </div>
      )}
    </div>
  );
}
