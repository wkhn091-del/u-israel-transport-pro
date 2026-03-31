"use client";
import { useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { ArrowLeftRight, X, Loader2, Search, Navigation } from "lucide-react";
import StationBoard from "./StationBoard";
import BottomSheet from "./BottomSheet";
import RoutePlanner from "./RoutePlanner";
import type { Vehicle } from "./TransportMap";
import type { BackendTripOption } from "./BottomSheet";

const TransportMap = dynamic(() => import("./TransportMap"), {
  ssr: false,
  loading: () => (
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "#f5f3ff", gap: 16,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: "50%",
        border: "3px solid #ddd6fe", borderTopColor: "#7c3aed",
        animation: "spin 0.8s linear infinite",
      }} />
      <span style={{ color: "#7c3aed", fontWeight: 700, fontSize: 15, fontFamily: "inherit" }}>
        טוען מפת תחבורה…
      </span>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  ),
});

export interface Layers {
  trains: boolean;
  buses: boolean;
  flights: boolean;
}

export type ActivePanel = "map" | "station-board" | "schedule";

export interface TripPlan {
  origin: string;
  destination: string;
  distance_km: number;
  duration_min: number;
}

// ── City / line suggestions ───────────────────────────────────────────────────
const CITY_SUGGESTIONS = [
  "תל אביב", "ירושלים", "חיפה", "באר שבע", "אילת",
  "נתניה", "רמת גן", "פתח תקווה", "אשדוד", "אשקלון",
  "טבריה", "נצרת", "הרצליה", "רחובות", "כפר סבא",
  "ראשון לציון", "בני ברק", "בת ים", "חולון", "מודיעין",
  "ניו יורק", "לונדון", "פריז", "דובאי", "ברלין",
  "אמסטרדם", "רומא", "מדריד", "אנקרה", "קהיר",
  "New York", "London", "Paris", "Dubai", "Berlin",
  "Amsterdam", "Rome", "Madrid", "Tokyo", "Mumbai",
];

const INTL_KEYWORDS = [
  "new york", "london", "paris", "dubai", "berlin", "amsterdam",
  "rome", "madrid", "tokyo", "mumbai", "ankara", "cairo",
  "ניו יורק", "לונדון", "פריז", "דובאי", "ברלין", "אמסטרדם",
  "רומא", "מדריד", "טוקיו", "מומבאי", "אנקרה", "קהיר",
  "usa", "uk", "germany", "france", "italy", "spain",
  "ארצות הברית", "אנגליה", "גרמניה", "צרפת", "איטליה", "ספרד",
  "אמריקה", "אירופה", "אסיה", "america", "europe", "asia",
];

// Israel bounding box
const IL_BBOX = { minLat: 29.3, maxLat: 33.5, minLon: 34.0, maxLon: 36.2 };

function isInternational(lat: number, lon: number): boolean {
  return lat < IL_BBOX.minLat || lat > IL_BBOX.maxLat ||
         lon < IL_BBOX.minLon || lon > IL_BBOX.maxLon;
}

function isInternationalKeyword(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return INTL_KEYWORDS.some((k) => lower.includes(k));
}

// Great-circle arc between two lat/lon points (Slerp)
function greatCircleArc(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  steps = 60,
): [number, number][] {
  const R2D = 180 / Math.PI, D2R = Math.PI / 180;
  const φ1 = lat1 * D2R, λ1 = lon1 * D2R;
  const φ2 = lat2 * D2R, λ2 = lon2 * D2R;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));
  if (d === 0) return [[lat1, lon1], [lat2, lon2]];
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([
      Math.atan2(z, Math.sqrt(x ** 2 + y ** 2)) * R2D,
      Math.atan2(y, x) * R2D,
    ]);
  }
  return pts;
}

async function geocodeCity(
  query: string,
  countryCode?: string,
): Promise<[number, number] | null> {
  try {
    const isIntl = isInternationalKeyword(query);
    const qWithSuffix = isIntl ? query : query + ", ישראל";
    const countryParam = isIntl ? "" : "&countrycodes=il";
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(qWithSuffix)}` +
      `${countryParam}&format=json&limit=1&accept-language=he,en`;
    const r = await fetch(url, {
      headers: { "Accept-Language": "he,en", "User-Agent": "IsraelTransportPro/1.0" },
    });
    const data = await r.json();
    if (data.length > 0) return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch { /* ignore */ }
  void countryCode;
  return null;
}

function getSuggestions(input: string): string[] {
  if (!input || input.length < 1) return [];
  const lower = input.toLowerCase();
  return CITY_SUGGESTIONS.filter((c) => c.toLowerCase().includes(lower)).slice(0, 5);
}

export default function Dashboard() {
  const [layers, setLayers] = useState<Layers>({ trains: true, buses: true, flights: true });
  const [activePanel, setActivePanel] = useState<ActivePanel>("map");
  const [selectedStopCode, setSelectedStopCode] = useState<number | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [focusMode, setFocusMode] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  const [showRoutePlanner, setShowRoutePlanner] = useState(false);

  // Dual search state
  const [originQuery, setOriginQuery]       = useState("");
  const [destQuery, setDestQuery]           = useState("");
  const [originSugg, setOriginSugg]         = useState<string[]>([]);
  const [destSugg, setDestSugg]             = useState<string[]>([]);
  const [activeInput, setActiveInput]       = useState<"origin" | "dest" | null>(null);
  const originRef = useRef<HTMLInputElement>(null);
  const destRef   = useRef<HTMLInputElement>(null);

  // Trip state
  const [tripPlan, setTripPlan]             = useState<TripPlan | null>(null);
  const [tripOptions, setTripOptions]       = useState<BackendTripOption[]>([]);
  const [isSearching, setIsSearching]       = useState(false);
  const [searchError, setSearchError]       = useState("");

  // Interactive vehicle selection
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  // Global/international view
  const [globalView, setGlobalView] = useState(false);

  const openStationBoard = (stopCode: number) => {
    setSelectedStopCode(stopCode);
    setActivePanel("station-board");
  };

  const handleVehiclesUpdate = useCallback((v: Vehicle[]) => setVehicles(v), []);

  const handleRouteFound = useCallback((coords: [number, number][]) => {
    setRouteCoords(coords);
    if (coords.length > 0) setShowRoutePlanner(false);
  }, []);

  const handleLayersChange = useCallback((l: Layers) => setLayers(l), []);

  // Called when user clicks a vehicle in the map or in the list
  const handleVehicleSelect = useCallback((v: Vehicle | null) => {
    setSelectedVehicleId(v?.id ?? null);
  }, []);

  // ── Origin input change ───────────────────────────────────────────────────
  const handleOriginChange = (val: string) => {
    setOriginQuery(val);
    setSearchError("");
    setOriginSugg(getSuggestions(val));
  };

  // ── Dest input change ─────────────────────────────────────────────────────
  const handleDestChange = (val: string) => {
    setDestQuery(val);
    setSearchError("");
    setDestSugg(getSuggestions(val));
  };

  // ── Swap origin ↔ destination ─────────────────────────────────────────────
  const handleSwap = useCallback(() => {
    setOriginQuery((prev) => {
      const tmp = destQuery;
      setDestQuery(prev);
      return tmp;
    });
    setOriginSugg([]);
    setDestSugg([]);
  }, [destQuery]);

  // ── Search ────────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    const from = originQuery.trim();
    const to   = destQuery.trim();
    if (!from || !to) {
      setSearchError("אנא הזן עיר מוצא ויעד");
      return;
    }

    setIsSearching(true);
    setSearchError("");
    setTripPlan(null);
    setTripOptions([]);
    setOriginSugg([]);
    setDestSugg([]);
    setActiveInput(null);

    const [fromCoords, toCoords] = await Promise.all([
      geocodeCity(from),
      geocodeCity(to),
    ]);

    if (!fromCoords || !toCoords) {
      setSearchError(
        !fromCoords ? `לא נמצא: "${from}"` : `לא נמצא: "${to}"`
      );
      setIsSearching(false);
      return;
    }

    const intl = isInternational(toCoords[0], toCoords[1]) ||
                 isInternational(fromCoords[0], fromCoords[1]) ||
                 isInternationalKeyword(from) ||
                 isInternationalKeyword(to);

    setGlobalView(intl);

    let routedPlan: TripPlan = { origin: from, destination: to, distance_km: 0, duration_min: 0 };

    if (intl) {
      // International route: draw great-circle arc, no OSRM
      const arc = greatCircleArc(fromCoords[0], fromCoords[1], toCoords[0], toCoords[1]);
      setRouteCoords(arc);
      // Straight-line haversine distance
      const R = 6371;
      const dLat = (toCoords[0] - fromCoords[0]) * Math.PI / 180;
      const dLon = (toCoords[1] - fromCoords[1]) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(fromCoords[0] * Math.PI / 180) * Math.cos(toCoords[0] * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
      const distKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      routedPlan = { origin: from, destination: to, distance_km: distKm, duration_min: Math.round(distKm / 800) };

      // Build a single flight option for international
      setTripOptions([{
        id: "intl_flight",
        type: "flight",
        label: "טיסה בינלאומית",
        line: "INT",
        operator: "בינלאומי",
        direct: true,
        duration_min: routedPlan.duration_min,
        price_ils: Math.round(distKm * 0.5),
        next_departure_min: 120,
        legs: [{ type: "flight", from, to }],
      }]);
    } else {
      // Domestic: fetch OSRM route + trip options in parallel
      await Promise.allSettled([
        fetch(
          `http://localhost:8001/api/routing/plan` +
          `?from_lat=${fromCoords[0]}&from_lon=${fromCoords[1]}` +
          `&to_lat=${toCoords[0]}&to_lon=${toCoords[1]}`
        ).then((r) => r.json()).then((data) => {
          if (!data.error) {
            setRouteCoords(data.coordinates ?? []);
            routedPlan = {
              origin: from, destination: to,
              distance_km: data.distance_km ?? 0,
              duration_min: data.duration_min ?? 0,
            };
          }
        }).catch(() => {}),

        fetch(
          `http://localhost:8001/api/routing/trip-options` +
          `?origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}` +
          `&from_lat=${fromCoords[0]}&from_lon=${fromCoords[1]}` +
          `&to_lat=${toCoords[0]}&to_lon=${toCoords[1]}`
        ).then((r) => r.json()).then((data) => {
          if (data.options && Array.isArray(data.options)) {
            setTripOptions(data.options as BackendTripOption[]);
            if (routedPlan.distance_km === 0 && data.distance_km) {
              routedPlan.distance_km = data.distance_km;
              routedPlan.duration_min = Math.round(data.distance_km * 1.2);
            }
          }
        }).catch(() => {}),
      ]);

      if (routedPlan.distance_km === 0) {
        const [lat1, lon1] = fromCoords, [lat2, lon2] = toCoords;
        const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        routedPlan.distance_km = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        routedPlan.duration_min = Math.round(routedPlan.distance_km * 1.2);
      }
    }

    setTripPlan(routedPlan);
    setIsSearching(false);
  }, [originQuery, destQuery]);

  const handleClearSearch = useCallback(() => {
    setOriginQuery("");
    setDestQuery("");
    setSearchError("");
    setTripPlan(null);
    setTripOptions([]);
    setRouteCoords([]);
    setGlobalView(false);
    setOriginSugg([]);
    setDestSugg([]);
    setActiveInput(null);
  }, []);

  // ── Suggestion list ───────────────────────────────────────────────────────
  const SuggList = ({
    items, onPick,
  }: { items: string[]; onPick: (v: string) => void }) => {
    if (!items.length) return null;
    return (
      <div style={{
        position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
        background: "#ffffff", borderRadius: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
        border: "1px solid #ddd6fe", zIndex: 2000, overflow: "hidden",
      }}>
        {items.map((c) => (
          <button key={c} onMouseDown={() => onPick(c)} style={{
            display: "block", width: "100%", textAlign: "right",
            padding: "10px 14px", border: "none", background: "transparent",
            fontSize: 14, fontWeight: 600, color: "#1e1b4b",
            cursor: "pointer", fontFamily: "inherit",
            borderBottom: "1px solid #f5f3ff",
          }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#f5f3ff")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {c}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div style={{
      position: "fixed", inset: 0,
      width: "100vw", height: "100dvh",
      overflow: "hidden", background: "#f5f3ff",
    }}>

      {/* ── LAYER 0: Full-screen map ── */}
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <TransportMap
          layers={layers}
          onStopClick={openStationBoard}
          onVehiclesUpdate={handleVehiclesUpdate}
          focusMode={focusMode}
          lineFilter={lineFilter}
          routeCoords={routeCoords}
          onFocusModeChange={setFocusMode}
          selectedVehicleId={selectedVehicleId}
          onVehicleSelect={handleVehicleSelect}
          globalView={globalView}
        />
      </div>

      {/* ── LAYER 1: Dual Search Bar ── */}
      <div style={{
        position: "absolute", top: 16, left: "50%",
        transform: "translateX(-50%)",
        width: "min(600px, calc(100vw - 24px))",
        zIndex: 1000,
      }}>
        <div style={{
          background: "#ffffff",
          borderRadius: 20,
          boxShadow: "0 8px 32px rgba(124,58,237,0.22), 0 2px 8px rgba(0,0,0,0.07)",
          border: `1.5px solid ${searchError ? "#fca5a5" : "#ddd6fe"}`,
          overflow: "visible",
        }}>
          {/* ── Origin row ── */}
          <div style={{ position: "relative" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "11px 16px",
              borderBottom: "1px solid #f0eeff",
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#7c3aed", flexShrink: 0,
              }} />
              <input
                ref={originRef}
                value={originQuery}
                onChange={(e) => handleOriginChange(e.target.value)}
                onFocus={() => setActiveInput("origin")}
                onBlur={() => setTimeout(() => setActiveInput(null), 150)}
                onKeyDown={(e) => { if (e.key === "Enter") { destRef.current?.focus(); } }}
                placeholder="עיר מוצא · Origin"
                dir="rtl"
                style={{
                  flex: 1, background: "transparent", border: "none",
                  outline: "none", fontSize: 14, fontWeight: 600,
                  color: "#1e1b4b", fontFamily: "inherit",
                }}
              />
              {isSearching && <Loader2 size={16} color="#7c3aed" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} />}
            </div>
            {activeInput === "origin" && <SuggList items={originSugg} onPick={(v) => { setOriginQuery(v); setOriginSugg([]); destRef.current?.focus(); }} />}
          </div>

          {/* ── Swap + Destination row ── */}
          <div style={{ position: "relative" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "11px 16px",
            }}>
              {/* Swap button */}
              <button
                onClick={handleSwap}
                title="הפוך כיוון"
                style={{
                  flexShrink: 0, width: 26, height: 26, borderRadius: "50%",
                  background: "#f0eeff", border: "1.5px solid #ddd6fe",
                  color: "#7c3aed", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#7c3aed"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#f0eeff"; e.currentTarget.style.color = "#7c3aed"; }}
              >
                <ArrowLeftRight size={13} />
              </button>

              <input
                ref={destRef}
                value={destQuery}
                onChange={(e) => handleDestChange(e.target.value)}
                onFocus={() => setActiveInput("dest")}
                onBlur={() => setTimeout(() => setActiveInput(null), 150)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                placeholder="יעד · Destination"
                dir="rtl"
                style={{
                  flex: 1, background: "transparent", border: "none",
                  outline: "none", fontSize: 14, fontWeight: 600,
                  color: "#1e1b4b", fontFamily: "inherit",
                }}
              />

              {/* Search button */}
              <button
                onClick={handleSearch}
                disabled={isSearching}
                style={{
                  flexShrink: 0, height: 32, paddingLeft: 14, paddingRight: 14,
                  borderRadius: 10, border: "none",
                  background: isSearching ? "#e9d5ff" : "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
                  color: "#ffffff", cursor: isSearching ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                  fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                  boxShadow: isSearching ? "none" : "0 3px 12px rgba(124,58,237,0.35)",
                }}
              >
                <Search size={13} />
                חפש
              </button>

              {(originQuery || destQuery) && !isSearching && (
                <button
                  onClick={handleClearSearch}
                  style={{
                    flexShrink: 0, width: 22, height: 22, borderRadius: "50%",
                    border: "none", background: "#f0eeff", color: "#7c3aed",
                    cursor: "pointer", display: "flex",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {activeInput === "dest" && <SuggList items={destSugg} onPick={(v) => { setDestQuery(v); setDestSugg([]); handleSearch(); }} />}
          </div>
        </div>

        {searchError && (
          <div style={{
            marginTop: 6, padding: "8px 14px", borderRadius: 10,
            background: "#fff7ed", border: "1px solid #fed7aa",
            fontSize: 12, color: "#c2410c", fontWeight: 600,
            fontFamily: "inherit",
          }} dir="rtl">
            {searchError}
          </div>
        )}

        {/* International indicator */}
        {globalView && (
          <div style={{
            marginTop: 6, padding: "6px 12px", borderRadius: 10,
            background: "#fff7ed", border: "1px solid #fcd34d",
            fontSize: 12, color: "#b45309", fontWeight: 700,
            fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6,
          }} dir="rtl">
            <Navigation size={12} />
            מסלול בינלאומי · מציג מסלול טיסה גלובלי
          </div>
        )}
      </div>

      {/* ── LAYER 1: Focus Mode pill ── */}
      {focusMode && !globalView && (
        <div style={{
          position: "absolute", top: 116, left: "50%",
          transform: "translateX(-50%)", zIndex: 900,
          display: "flex", alignItems: "center", gap: 6,
          background: "rgba(124,58,237,0.10)",
          border: "1px solid rgba(124,58,237,0.30)",
          borderRadius: 999, padding: "5px 14px",
          pointerEvents: "none", whiteSpace: "nowrap",
          fontFamily: "inherit",
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#7c3aed",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
            מצב מיקוד · 1 ק&quot;מ
          </span>
          {lineFilter && (
            <span style={{ fontSize: 12, color: "#a855f7", fontWeight: 600 }}>
              · קו {lineFilter}
            </span>
          )}
        </div>
      )}

      {/* ── LAYER 2: Station Board ── */}
      {activePanel === "station-board" && (
        <div style={{
          position: "absolute", top: 0, right: 0,
          width: 400, height: "100%", zIndex: 500,
          background: "#ffffff", borderLeft: "1.5px solid #ddd6fe",
          boxShadow: "-8px 0 40px rgba(124,58,237,0.10)",
          display: "flex", flexDirection: "column",
          animation: "slideInRight 0.22s cubic-bezier(0.32,0.72,0,1)",
        }}>
          <StationBoard
            initialStopCode={selectedStopCode}
            onClose={() => setActivePanel("map")}
          />
        </div>
      )}

      {/* ── LAYER 2: Route Planner modal ── */}
      {showRoutePlanner && (
        <RoutePlanner
          onRouteFound={handleRouteFound}
          onClose={() => setShowRoutePlanner(false)}
        />
      )}

      {/* ── LAYER 3: Bottom Sheet ── */}
      <BottomSheet
        vehicles={vehicles}
        lineFilter={lineFilter}
        onLineFilterChange={setLineFilter}
        onShowRoutePlanner={() => setShowRoutePlanner((v) => !v)}
        tripPlan={tripPlan}
        tripOptions={tripOptions}
        focusMode={focusMode}
        onTripPlanClose={() => { setTripPlan(null); setTripOptions([]); setRouteCoords([]); setOriginQuery(""); setDestQuery(""); setGlobalView(false); }}
        onLayersChange={handleLayersChange}
        onVehicleSelect={handleVehicleSelect}
        selectedVehicleId={selectedVehicleId}
      />

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
