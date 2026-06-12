import { useEffect, useRef, useState, useCallback } from 'react';
import type { GeoFeature } from '@/lib/portfolio-api';
import { Maximize2, Minimize2, Crosshair, X } from 'lucide-react';

const ECOSYSTEM_COLORS: Record<string, string> = {
  'Mangrove Forest':           '#10b981',
  'Seagrass Meadow':           '#06b6d4',
  'Salt Marsh':                '#f59e0b',
  'Coastal Wetland':           '#3b82f6',
  'Freshwater Wetland':        '#0ea5e9',
  'Lake Restoration':          '#38bdf8',
  'River Restoration':         '#22d3ee',
  'Forest Restoration':        '#4ade80',
  'Agricultural Regeneration': '#a3e635',
  'Mixed Ecosystem':           '#e879f9',
  'Other / Unknown':           '#8b5cf6',
  // Legacy aliases
  'Mangrove':                  '#10b981',
  'Seagrass':                  '#06b6d4',
  'Coastal':                   '#3b82f6',
  'Other':                     '#8b5cf6',
};

const LEGACY_ALIASES = new Set(['Mangrove', 'Seagrass', 'Coastal', 'Other']);

function getColor(eco: string): string {
  return ECOSYSTEM_COLORS[eco] ?? ECOSYSTEM_COLORS['Other / Unknown'] ?? '#8b5cf6';
}

function getStatusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case 'verified':            return '#10b981';
    case 'pending':             return '#f59e0b';
    case 'rejected':            return '#ef4444';
    case 'needs_clarification': return '#f97316';
    default:                    return '#64748b';
  }
}

// Inject global CSS once — controls + legend animation + popup theming
const PM_STYLE_ID = 'nevara-portfolio-map-styles';
function injectPortfolioMapStyles() {
  if (document.getElementById(PM_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = PM_STYLE_ID;
  s.textContent = `
    @keyframes pmFadeIn {
      from { opacity: 0; transform: translateX(-5px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .pm-legend-item { animation: pmFadeIn 0.32s ease forwards; }
    .portfolio-map .leaflet-control-zoom a {
      width: 26px !important; height: 26px !important; line-height: 26px !important;
      font-size: 14px !important; border-radius: 5px !important;
      background: rgba(15,23,42,0.85) !important; color: #e2e8f0 !important;
      border: 1px solid rgba(255,255,255,0.10) !important;
      backdrop-filter: blur(6px) !important;
      transition: background 0.15s, color 0.15s !important;
    }
    .portfolio-map .leaflet-control-zoom a:hover {
      background: rgba(16,185,129,0.22) !important; color: #34d399 !important;
    }
    .portfolio-map .leaflet-control-zoom {
      border: none !important; box-shadow: none !important;
      display: flex !important; flex-direction: column !important; gap: 2px !important;
    }
    .portfolio-map .leaflet-control-attribution {
      background: rgba(0,0,0,0.38) !important; color: rgba(255,255,255,0.28) !important;
      font-size: 8px !important; padding: 1px 5px !important;
      border-radius: 3px 0 0 0 !important; max-width: 200px !important;
      white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
    }
    .portfolio-map .leaflet-bar { box-shadow: none !important; border: none !important; }
    .portfolio-map .leaflet-popup-content-wrapper {
      background: rgba(15,23,42,0.96) !important; color: #e2e8f0 !important;
      border: 1px solid rgba(255,255,255,0.10) !important;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
      border-radius: 10px !important; backdrop-filter: blur(12px) !important;
    }
    .portfolio-map .leaflet-popup-tip { background: rgba(15,23,42,0.96) !important; }
    .portfolio-map .leaflet-popup-close-button { color: #94a3b8 !important; right: 8px !important; top: 8px !important; }
  `;
  document.head.appendChild(s);
}

interface PortfolioMapProps {
  features: GeoFeature[];
  height?: number;
  onFeatureClick?: (feature: GeoFeature) => void;
}

export default function PortfolioMap({ features, height = 400, onFeatureClick }: PortfolioMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const allBoundsRef = useRef<[number, number][]>([]);
  const onFeatureClickRef = useRef(onFeatureClick);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeFeature, setActiveFeature] = useState<GeoFeature | null>(null);

  useEffect(() => { onFeatureClickRef.current = onFeatureClick; }, [onFeatureClick]);

  const fitBounds = useCallback(() => {
    if (mapRef.current && leafletRef.current && allBoundsRef.current.length > 0) {
      mapRef.current.fitBounds(
        leafletRef.current.latLngBounds(allBoundsRef.current),
        { padding: [40, 40], animate: true, duration: 0.9 },
      );
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((v) => !v);
    // Invalidate after CSS transition completes
    setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 320);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen((v) => { if (v) setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 320); return false; });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!containerRef.current || features.length === 0) return;

    injectPortfolioMapStyles();
    let destroyed = false;

    (async () => {
      try {
        const L = (await import('leaflet')).default;
        await import('leaflet/dist/leaflet.css');

        if (destroyed || !containerRef.current) return;

        if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
        leafletRef.current = L;

        const map = L.map(containerRef.current, {
          zoomControl: true,
          scrollWheelZoom: true,
          dragging: true,
        });

        map.zoomControl.setPosition('bottomright');

        // High-quality satellite base
        L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { attribution: '© Esri, Maxar', maxZoom: 19, maxNativeZoom: 19 },
        ).addTo(map);

        // Transparent geographic labels overlay
        L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 19, maxNativeZoom: 19, opacity: 0.88 },
        ).addTo(map);

        const allBounds: [number, number][] = [];

        for (const feature of features) {
          if (!feature.boundary || feature.boundary.length < 3) continue;

          const latLngs: [number, number][] = feature.boundary.map(
            (p) => [p.lat ?? (p as any)[0], p.lng ?? (p as any)[1]] as [number, number],
          );

          const color = getColor(feature.ecosystemType);
          const baseStyle = { color, fillColor: color, fillOpacity: 0.30, weight: 2 };

          const polygon = L.polygon(latLngs, baseStyle).addTo(map);

          // Smooth hover glow: brighten stroke + increase fill
          polygon.on('mouseover', function (this: any) {
            this.setStyle({ weight: 3.5, fillOpacity: 0.54, color: '#ffffff' });
            this.bringToFront();
          });
          polygon.on('mouseout', function (this: any) {
            this.setStyle(baseStyle);
          });

          // Click: show inline preview
          polygon.on('click', () => {
            setActiveFeature(feature);
            if (onFeatureClickRef.current) onFeatureClickRef.current(feature);
          });

          for (const ll of latLngs) allBounds.push(ll);
        }

        allBoundsRef.current = allBounds;

        if (allBounds.length > 0) {
          map.fitBounds(L.latLngBounds(allBounds), { padding: [36, 36] });
        } else {
          map.setView([20, 78], 5);
        }

        mapRef.current = map;
      } catch (err) {
        // Map init failed — container may not be mounted yet; will retry on next feature change
      }
    })();

    return () => {
      destroyed = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [features]);

  if (features.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex flex-col items-center justify-center bg-muted/20 rounded-xl border border-dashed border-border/60 gap-3 text-muted-foreground"
      >
        <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
          <Crosshair className="w-5 h-5 opacity-40" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">No mapped boundaries available</p>
          <p className="text-xs mt-0.5 opacity-60">Submit a project with a GIS boundary to populate the map</p>
        </div>
      </div>
    );
  }

  // Legend: only canonical ecosystems present in this dataset
  const presentEcos = [...new Set(features.map((f) => f.ecosystemType))];
  const legendItems = presentEcos
    .filter((eco) => !LEGACY_ALIASES.has(eco))
    .map((eco) => [eco, getColor(eco)] as [string, string]);

  const wrapperClass = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-slate-950 overflow-hidden'
    : 'relative rounded-xl overflow-hidden border border-border/60 shadow-md';

  return (
    <div className={wrapperClass} style={isFullscreen ? undefined : { height }}>
      {/* Leaflet renders here */}
      <div
        ref={containerRef}
        className="portfolio-map absolute inset-0"
        style={{ width: '100%', height: '100%' }}
      />

      {/* Site count badge (top-right) */}
      <div className="absolute top-3 right-3 z-[1000] bg-slate-900/82 backdrop-blur-md border border-white/10 rounded-full px-2.5 py-0.5 text-[10px] font-semibold text-slate-300 select-none">
        {features.length} site{features.length !== 1 ? 's' : ''}
      </div>

      {/* Fit + fullscreen buttons (top-left) */}
      <div className="absolute top-3 left-3 z-[1000] flex flex-col gap-1.5">
        <button
          type="button"
          onClick={fitBounds}
          title="Fit to all projects"
          className="w-8 h-8 flex items-center justify-center bg-slate-900/88 backdrop-blur-md border border-white/10 rounded-lg shadow-lg text-slate-300 hover:text-emerald-400 hover:border-emerald-500/30 transition-all duration-150"
        >
          <Crosshair className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
          className="w-8 h-8 flex items-center justify-center bg-slate-900/88 backdrop-blur-md border border-white/10 rounded-lg shadow-lg text-slate-300 hover:text-emerald-400 hover:border-emerald-500/30 transition-all duration-150"
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Ecosystem legend (bottom-left) */}
      {legendItems.length > 0 && (
        <div className="absolute bottom-3 left-3 z-[1000] bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-3 max-h-52 overflow-y-auto">
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-2">Ecosystems</p>
          <div className="space-y-1.5">
            {legendItems.map(([eco, color], i) => (
              <div
                key={eco}
                className="pm-legend-item flex items-center gap-2 opacity-0"
                style={{ animationDelay: `${i * 55}ms` }}
              >
                <span
                  className="shrink-0 rounded-sm"
                  style={{ background: color, width: 10, height: 10, display: 'inline-block' }}
                />
                <span className="text-[10px] text-slate-300 leading-none">{eco}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Project quick-preview panel (bottom-right on click) */}
      {activeFeature && (
        <div className="absolute bottom-3 right-3 z-[1001] w-56 bg-slate-900/96 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/8">
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Project</span>
            <button
              type="button"
              onClick={() => setActiveFeature(null)}
              className="text-slate-500 hover:text-slate-200 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="p-3 space-y-2.5">
            <div>
              <p className="text-sm font-semibold text-white leading-tight line-clamp-2">{activeFeature.name}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className="rounded-sm shrink-0"
                  style={{ background: getColor(activeFeature.ecosystemType), width: 8, height: 8, display: 'inline-block' }}
                />
                <span className="text-[10px] text-slate-400">{activeFeature.ecosystemType}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {activeFeature.areaHa != null && (
                <div className="bg-white/5 rounded-lg p-2">
                  <p className="text-[8px] uppercase tracking-wider text-slate-500 mb-0.5">Area</p>
                  <p className="text-xs font-bold text-white">{Number(activeFeature.areaHa).toFixed(1)} ha</p>
                </div>
              )}
              {activeFeature.trustScore != null && (
                <div className="bg-white/5 rounded-lg p-2">
                  <p className="text-[8px] uppercase tracking-wider text-slate-500 mb-0.5">Health</p>
                  <p
                    className="text-xs font-bold"
                    style={{
                      color: activeFeature.trustScore >= 70 ? '#10b981'
                        : activeFeature.trustScore >= 45 ? '#f59e0b'
                        : '#ef4444',
                    }}
                  >
                    {activeFeature.trustScore}/100
                  </p>
                </div>
              )}
              <div className="bg-white/5 rounded-lg p-2 col-span-2">
                <p className="text-[8px] uppercase tracking-wider text-slate-500 mb-0.5">Verification</p>
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: getStatusColor(activeFeature.status) }}
                  />
                  <span className="text-[11px] font-semibold text-slate-200 capitalize">
                    {activeFeature.status?.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
