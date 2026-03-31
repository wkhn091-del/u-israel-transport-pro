"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import type { Layers } from "./Dashboard";
import VehiclePopup from "./VehiclePopup";
import { Navigation, Target } from "lucide-react";

export interface Vehicle {
  id: string;
  lat: number;
  lon: number;
  type: "train" | "bus" | "flight";
  [key: string]: unknown;
}

interface BusStop {
  code: number;
  name: string;
  city: string;
  lat: number;
  lon: number;
}

interface RouteStop {
  lat: number;
  lon: number;
  name: string;
  code?: number;
}

interface TrackedVehicle {
  vehicle: Vehicle;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  startTime: number;
}

type LeafletCircle   = { remove(): void; setLatLng(ll: [number, number]): void };
type LeafletPolyline = { remove(): void; getBounds(): unknown };
type LeafletMarker   = { remove(): void };

const ISRAEL_CENTER: [number, number]  = [31.7683, 35.2137];
const INITIAL_ZOOM    = 8;
const STOP_MIN_ZOOM   = 14;
const LABEL_MIN_ZOOM  = 13;
const GLIDE_MS        = 8000;
const HIT_RADIUS      = 24;
const FOCUS_RADIUS_M  = 1000;
const FOCUS_LAT_DELTA = FOCUS_RADIUS_M / 111_000;
const COLORS = { train: "#2563eb", bus: "#16a34a", flight: "#d97706" };

// Tiberias has no rail service — suppress train markers when focused there
const TIBERIAS_BBOX = { south: 32.74, north: 32.86, west: 35.50, east: 35.60 };
function isInTiberias(lat: number, lon: number) {
  return lat >= TIBERIAS_BBOX.south && lat <= TIBERIAS_BBOX.north &&
         lon >= TIBERIAS_BBOX.west  && lon <= TIBERIAS_BBOX.east;
}

const WORKER_SRC = `
self.onmessage = ({ data: buses }) => {
  const best = new Map();
  for (const b of buses) {
    const k = b.vehicle_ref || b.id;
    if (!best.has(k) || best.get(k).id < b.id) best.set(k, b);
  }
  self.postMessage([...best.values()]);
};
`;

function easeOut(t: number) { return 1 - (1 - Math.min(t, 1)) ** 3; }


function rRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  type: "train" | "bus" | "flight",
  headingDeg: number,
  isSelected: boolean,
  now: number,
) {
  const color = COLORS[type];

  // ── Pulsing live ring ─────────────────────────────────────────────────────
  const phase = (now % 2000) / 2000;
  ctx.save();
  ctx.globalAlpha = Math.max(0, 0.6 - phase * 0.6);
  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.beginPath();
  ctx.arc(x, y, 14 + phase * 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Outer glow for selected vehicle
  if (isSelected) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Vehicle body ──────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((headingDeg * Math.PI) / 180);
  ctx.shadowBlur  = isSelected ? 24 : 8;
  ctx.shadowColor = color + "cc";

  if (type === "bus") {
    ctx.fillStyle = color;
    rRect(ctx, -6, -10, 12, 20, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(-5, -8, 4, 4); ctx.fillRect(1, -8, 4, 4);
    ctx.fillRect(-5, -2, 4, 4); ctx.fillRect(1, -2, 4, 4);
    ctx.fillStyle = "rgba(0,0,0,0.30)"; ctx.fillRect(-4, 5, 8, 3);
  } else if (type === "train") {
    ctx.fillStyle = color;
    rRect(ctx, -5, -11, 10, 22, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.40)";
    ctx.fillRect(-4, -9, 3, 4); ctx.fillRect(1, -9, 3, 4);
    ctx.fillRect(-4, -3, 3, 4); ctx.fillRect(1, -3, 3, 4);
    ctx.fillRect(-3, 5, 6, 4);
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(1.5, -4); ctx.lineTo(11, 2);
    ctx.lineTo(11, 4); ctx.lineTo(1.5, 1); ctx.lineTo(2, 7);
    ctx.lineTo(5, 8); ctx.lineTo(5, 10); ctx.lineTo(0, 9);
    ctx.lineTo(-5, 10); ctx.lineTo(-5, 8); ctx.lineTo(-2, 7);
    ctx.lineTo(-1.5, 1); ctx.lineTo(-11, 4); ctx.lineTo(-11, 2);
    ctx.lineTo(-1.5, -4); ctx.closePath(); ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.80)";
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  if (type === "bus")   { rRect(ctx, -6, -10, 12, 20, 3); ctx.stroke(); }
  else if (type === "train") { rRect(ctx, -5, -11, 10, 22, 3); ctx.stroke(); }
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, vehicle: Vehicle) {
  let primary = "";
  let secondary = "";
  const color = COLORS[vehicle.type];

  if (vehicle.type === "bus") {
    // Prefer the human-readable route_short_name (e.g. "430") over the raw
    // internal SIRI line_ref (e.g. "7929") that the backend also returns.
    const short = vehicle.route_short_name as string | undefined;
    const lr    = vehicle.line_ref as number | string | undefined;
    const label = short || (lr != null ? String(lr) : null);
    if (!label) return;
    primary = label;
  } else if (vehicle.type === "train") {
    primary = String((vehicle.train_number as string | undefined) ?? "");
    const dst = (vehicle.destination as string | undefined) ?? "";
    secondary = dst.length > 7 ? dst.slice(0, 6) + "…" : dst;
  } else {
    const cs = ((vehicle.callsign as string | undefined) ?? "").trim();
    if (!cs) return;
    primary = cs.length > 7 ? cs.slice(0, 6) + "…" : cs;
  }
  if (!primary) return;

  const text = secondary ? `${primary} ← ${secondary}` : primary;
  ctx.save();
  ctx.font = "bold 8px 'Heebo',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const tw = ctx.measureText(text).width;
  const pw = tw + 10, ph = 13;
  const px = x - pw / 2, py = y - 24 - ph;

  ctx.shadowBlur = 5; ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  rRect(ctx, px, py, pw, ph, 3); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color + "cc"; ctx.lineWidth = 1;
  rRect(ctx, px, py, pw, ph, 3); ctx.stroke();
  ctx.fillStyle = "#1e1b4b";
  ctx.fillText(text, x, py + ph / 2);
  ctx.restore();
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function TransportMap({
  layers,
  onStopClick,
  onVehiclesUpdate,
  focusMode = false,
  lineFilter = "",
  routeCoords = [],
  onFocusModeChange,
  selectedVehicleId = null,
  onVehicleSelect,
  globalView = false,
}: {
  layers: Layers;
  onStopClick?: (stopCode: number) => void;
  onVehiclesUpdate?: (vehicles: Vehicle[]) => void;
  focusMode?: boolean;
  lineFilter?: string;
  routeCoords?: [number, number][];
  onFocusModeChange?: (v: boolean) => void;
  selectedVehicleId?: string | null;
  onVehicleSelect?: (v: Vehicle | null) => void;
  globalView?: boolean;
}) {
  const outerRef            = useRef<HTMLDivElement>(null);
  const containerRef        = useRef<HTMLDivElement>(null);
  const canvasRef           = useRef<HTMLCanvasElement>(null);
  const mapRef              = useRef<L.Map | null>(null);
  const trackedRef          = useRef<Map<string, TrackedVehicle>>(new Map());
  const stopMarkersRef      = useRef<Map<number, L.Marker>>(new Map());
  const trainStMarkersRef   = useRef<LeafletMarker[]>([]);
  const routeStopMarkersRef = useRef<LeafletMarker[]>([]);
  const routeLineRef        = useRef<LeafletPolyline | null>(null);
  const stopsLoadedForRef   = useRef<string>("");
  const rafRef              = useRef<number>(0);
  const workerRef           = useRef<Worker | null>(null);
  const layersRef           = useRef<Layers>(layers);
  const focusModeRef        = useRef(focusMode);
  const lineFilterRef       = useRef(lineFilter);
  const vehiclesRef         = useRef<Vehicle[]>([]);
  const selectedRef         = useRef<Vehicle | null>(null);
  const onVehiclesUpdateRef = useRef(onVehiclesUpdate);
  const onStopClickRef      = useRef(onStopClick);
  const onVehicleSelectRef  = useRef(onVehicleSelect);
  const focusCircleRef      = useRef<LeafletCircle | null>(null);
  const routePolylineRef    = useRef<LeafletPolyline | null>(null);
  const prevSelectedIdRef   = useRef<string | null>(null);

  const [selectedDisplay, setSelectedDisplay] = useState<Vehicle | null>(null);
  const [mapReady,    setMapReady]    = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [vehicleCount,  setVehicleCount]  = useState(0);
  const [locating,      setLocating]      = useState(false);
  const [routeInfo,     setRouteInfo]     = useState<{ line: string; stopCount: number } | null>(null);
  const [backendOffline, setBackendOffline] = useState(false);

  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { onVehiclesUpdateRef.current = onVehiclesUpdate; }, [onVehiclesUpdate]);
  useEffect(() => { onStopClickRef.current = onStopClick; }, [onStopClick]);
  useEffect(() => { onVehicleSelectRef.current = onVehicleSelect; }, [onVehicleSelect]);

  // ── Web Worker ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const blob = new Blob([WORKER_SRC], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    workerRef.current = new Worker(url);
    URL.revokeObjectURL(url);
    return () => { workerRef.current?.terminate(); };
  }, []);

  const deduplicateBuses = useCallback((buses: Vehicle[]): Promise<Vehicle[]> => {
    return new Promise((resolve) => {
      const w = workerRef.current;
      if (!w) { resolve(buses); return; }
      const handler = (e: MessageEvent) => { w.removeEventListener("message", handler); resolve(e.data as Vehicle[]); };
      w.addEventListener("message", handler);
      w.postMessage(buses);
    });
  }, []);

  const updateVehicles = useCallback((vehicles: Vehicle[]) => {
    const now = performance.now();
    const activeIds = new Set(vehicles.map((v) => v.id));
    for (const id of trackedRef.current.keys()) if (!activeIds.has(id)) trackedRef.current.delete(id);
    for (const v of vehicles) {
      const ex = trackedRef.current.get(v.id);
      if (ex) {
        const t = easeOut((now - ex.startTime) / GLIDE_MS);
        const curLat = ex.fromLat + (ex.toLat - ex.fromLat) * t;
        const curLon = ex.fromLon + (ex.toLon - ex.fromLon) * t;
        trackedRef.current.set(v.id, { vehicle: v, fromLat: curLat, fromLon: curLon, toLat: v.lat, toLon: v.lon, startTime: now });
      } else {
        trackedRef.current.set(v.id, { vehicle: v, fromLat: v.lat, fromLon: v.lon, toLat: v.lat, toLon: v.lon, startTime: now });
      }
    }
    vehiclesRef.current = vehicles;
    setVehicleCount(vehicles.length);
    onVehiclesUpdateRef.current?.(vehicles);
    if (selectedRef.current) {
      const r = vehicles.find((v) => v.id === selectedRef.current!.id);
      if (r) { selectedRef.current = r; setSelectedDisplay(r); }
    }
  }, []);

  const getFocusBbox = useCallback(() => {
    if (!mapRef.current) return null;
    const c = mapRef.current.getCenter();
    const lonDelta = FOCUS_RADIUS_M / (111_000 * Math.cos((c.lat * Math.PI) / 180));
    return { south: c.lat - FOCUS_LAT_DELTA, north: c.lat + FOCUS_LAT_DELTA, west: c.lng - lonDelta, east: c.lng + lonDelta };
  }, []);

  const fetchBuses = useCallback(async (): Promise<Vehicle[]> => {
    if (!mapRef.current || !layersRef.current.buses) return [];
    let south: number, north: number, west: number, east: number;
    if (focusModeRef.current) {
      const fb = getFocusBbox(); if (!fb) return [];
      ({ south, north, west, east } = fb);
    } else {
      const b = mapRef.current.getBounds();
      south = b.getSouth(); north = b.getNorth(); west = b.getWest(); east = b.getEast();
    }
    const lineParam = lineFilterRef.current ? `&line_ref=${encodeURIComponent(lineFilterRef.current)}` : "";
    try {
      const r = await fetch(
        `http://localhost:8001/api/buses/live?lat_min=${south.toFixed(4)}&lat_max=${north.toFixed(4)}&lon_min=${west.toFixed(4)}&lon_max=${east.toFixed(4)}&limit=300${lineParam}`
      );
      const d = await r.json();
      const raw = (d.buses ?? []).map((b: Vehicle) => ({ ...b, type: "bus" as const }));
      return deduplicateBuses(raw);
    } catch { return []; }
  }, [deduplicateBuses, getFocusBbox]);

  const fetchAll = useCallback(async () => {
    if (!mapRef.current) return;
    setLoading(true);
    let vehicles: Vehicle[] = [];
    let anyApiUnavailable = false;

    await Promise.allSettled([
      layersRef.current.trains
        ? fetch("http://localhost:8001/api/trains/live")
            .then((r) => r.json())
            .then((d) => {
              if (d.service_status === "unavailable") { anyApiUnavailable = true; return; }
              d.trains?.forEach((t: Vehicle) => vehicles.push({ ...t, type: "train" }));
            })
            .catch(() => { anyApiUnavailable = true; })
        : Promise.resolve(),

      fetchBuses().then((bs) => { vehicles.push(...bs); }),

      layersRef.current.flights
        ? fetch("http://localhost:8001/api/flights/live")
            .then((r) => r.json())
            .then((d) => {
              if (d.service_status === "unavailable") { anyApiUnavailable = true; return; }
              d.flights?.forEach((f: Vehicle) => vehicles.push({ ...f, type: "flight" }));
            })
            .catch(() => {})
        : Promise.resolve(),
    ]);

    // Tiberias has no rail service — drop train markers when focused there
    if (mapRef.current && focusModeRef.current) {
      const c = mapRef.current.getCenter();
      if (isInTiberias(c.lat, c.lng)) {
        vehicles = vehicles.filter((v) => v.type !== "train");
      }
    }

    // Show "unavailable" banner only when APIs explicitly report down (not just empty area)
    setBackendOffline(anyApiUnavailable && vehicles.length === 0);
    updateVehicles(vehicles);
    setLoading(false);
  }, [fetchBuses, updateVehicles]);

  // ── Focus circle ─────────────────────────────────────────────────────────────
  const updateFocusCircle = useCallback(async () => {
    if (!mapRef.current) return;
    const L = (await import("leaflet")).default;
    focusCircleRef.current?.remove();
    focusCircleRef.current = null;
    if (focusModeRef.current) {
      const c = mapRef.current.getCenter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      focusCircleRef.current = L.circle([c.lat, c.lng], {
        radius: FOCUS_RADIUS_M, color: "#7c3aed", fillColor: "#7c3aed",
        fillOpacity: 0.06, weight: 2, dashArray: "6 4",
        interactive: false as unknown as boolean,
      }).addTo(mapRef.current) as unknown as LeafletCircle;
    }
  }, []);

  useEffect(() => {
    focusModeRef.current = focusMode;
    if (!mapReady) return;
    updateFocusCircle();
    fetchAll();
  }, [focusMode, mapReady, updateFocusCircle, fetchAll]);

  useEffect(() => {
    lineFilterRef.current = lineFilter;
    if (!mapReady) return;
    fetchAll();
  }, [lineFilter, mapReady, fetchAll]);

  // ── Route polyline (from search) ─────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (async () => {
      const L = (await import("leaflet")).default;
      routePolylineRef.current?.remove();
      routePolylineRef.current = null;
      if (routeCoords && routeCoords.length > 1) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pl = L.polyline(routeCoords as any, {
          color: "#7c3aed", weight: 5, opacity: 0.88,
          dashArray: globalView ? "8 4" : undefined,
        }).addTo(mapRef.current!);
        routePolylineRef.current = pl as unknown as LeafletPolyline;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapRef.current!.fitBounds((pl as any).getBounds(), { padding: [50, 50], maxZoom: globalView ? 5 : 14 });
      }
    })();
  }, [routeCoords, mapReady, globalView]);

  // ── Global view mode ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (globalView && (!routeCoords || routeCoords.length === 0)) {
      mapRef.current.flyTo([30, 20], 3, { duration: 1.5 });
    }
  }, [globalView, mapReady, routeCoords]);

  // ── Clear route display helpers ──────────────────────────────────────────────
  const clearRouteDisplay = useCallback(() => {
    routeLineRef.current?.remove();
    routeLineRef.current = null;
    for (const m of routeStopMarkersRef.current) m.remove();
    routeStopMarkersRef.current = [];
    setRouteInfo(null);
  }, []);

  // ── Show bus line route stops ─────────────────────────────────────────────────
  const showBusLineRoute = useCallback(async (lineRef: string) => {
    if (!mapRef.current) return;
    clearRouteDisplay();
    try {
      const r = await fetch(`http://localhost:8001/api/buses/line-path?line_ref=${encodeURIComponent(lineRef)}`);
      const d = await r.json();
      const stops: RouteStop[] = d.stops ?? [];
      if (stops.length < 2) return;

      const L = (await import("leaflet")).default;
      const coords = stops.map((s) => [s.lat, s.lon] as [number, number]);

      // Route polyline
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pl = L.polyline(coords as any, {
        color: "#16a34a", weight: 4, opacity: 0.85,
      }).addTo(mapRef.current!);
      routeLineRef.current = pl as unknown as LeafletPolyline;

      // Stop markers (small circles, on-demand only for this route)
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const isTerminus = i === 0 || i === stops.length - 1;
        const icon = L.divIcon({
          html: `<div style="
            width:${isTerminus ? 16 : 10}px;
            height:${isTerminus ? 16 : 10}px;
            background:${isTerminus ? "#16a34a" : "#ffffff"};
            border:2.5px solid #16a34a;
            border-radius:50%;
            box-shadow:0 2px 6px rgba(22,163,74,0.4);
          "></div>`,
          className: "", iconSize: [isTerminus ? 16 : 10, isTerminus ? 16 : 10],
          iconAnchor: [isTerminus ? 8 : 5, isTerminus ? 8 : 5],
        });
        const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: 60 })
          .addTo(mapRef.current!)
          .bindTooltip(
            `<div dir="rtl" style="font-family:'Heebo';font-size:12px;font-weight:700;padding:2px 0">${stop.name}</div>`,
            { direction: "top", offset: [0, -6] }
          );
        routeStopMarkersRef.current.push(m as unknown as LeafletMarker);
      }

      setRouteInfo({ line: lineRef, stopCount: stops.length });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapRef.current!.fitBounds((pl as any).getBounds(), { padding: [60, 60], maxZoom: 14 });
    } catch { /* non-critical */ }
  }, [clearRouteDisplay]);

  // ── Show train route (all major stations) ────────────────────────────────────
  const showTrainRoute = useCallback(async () => {
    if (!mapRef.current) return;
    clearRouteDisplay();
    try {
      const r = await fetch("http://localhost:8001/api/trains/stations");
      const d = await r.json();
      const stations: Array<{ lat: number; lon: number; name_he?: string; name_en?: string }> =
        d.stations ?? [];
      if (!stations.length) return;

      const L = (await import("leaflet")).default;
      const coords = stations.filter((s) => s.lat && s.lon).map((s) => [s.lat, s.lon] as [number, number]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pl = L.polyline(coords as any, {
        color: "#2563eb", weight: 4, opacity: 0.75, dashArray: "8 4",
      }).addTo(mapRef.current!);
      routeLineRef.current = pl as unknown as LeafletPolyline;

      for (const st of stations) {
        if (!st.lat || !st.lon) continue;
        const name = st.name_he || st.name_en || "תחנה";
        const icon = L.divIcon({
          html: `<div style="
            width:18px;height:18px;
            background:#2563eb;border:2.5px solid #fff;
            border-radius:4px;
            box-shadow:0 2px 8px rgba(37,99,235,0.45);
            display:flex;align-items:center;justify-content:center;
            font-size:9px;color:#fff;font-weight:900;
          ">R</div>`,
          className: "", iconSize: [18, 18], iconAnchor: [9, 9],
        });
        const m = L.marker([st.lat, st.lon], { icon, zIndexOffset: 60 })
          .addTo(mapRef.current!)
          .bindTooltip(
            `<div dir="rtl" style="font-family:'Heebo';font-size:12px;font-weight:700">${name}</div>`,
            { direction: "top" }
          );
        routeStopMarkersRef.current.push(m as unknown as LeafletMarker);
      }

      setRouteInfo({ line: "רכבת ישראל", stopCount: stations.length });
    } catch { /* non-critical */ }
  }, [clearRouteDisplay]);

  // ── Train stations in focus mode ─────────────────────────────────────────────
  const loadTrainStationsForFocus = useCallback(async () => {
    if (!mapRef.current || !focusModeRef.current) return;
    // Clear old markers
    for (const m of trainStMarkersRef.current) m.remove();
    trainStMarkersRef.current = [];
    if (!layersRef.current.trains) return;
    try {
      const r = await fetch("http://localhost:8001/api/trains/stations");
      const d = await r.json();
      const stations: Array<{ lat: number; lon: number; name_he?: string; name_en?: string }> =
        d.stations ?? [];
      const L = (await import("leaflet")).default;
      const center = mapRef.current.getCenter();
      // Only show stations within ~20 km of focus center
      for (const st of stations) {
        if (!st.lat || !st.lon) continue;
        const dlat = st.lat - center.lat, dlon = st.lon - center.lng;
        const distKm = Math.sqrt(dlat * dlat + dlon * dlon) * 111;
        if (distKm > 20) continue;
        const name = st.name_he || st.name_en || "תחנת רכבת";
        const icon = L.divIcon({
          html: `<div style="
            width:24px;height:24px;
            background:#2563eb;border:2.5px solid #fff;
            border-radius:6px;
            box-shadow:0 3px 10px rgba(37,99,235,0.40);
            display:flex;align-items:center;justify-content:center;
            font-family:'Heebo',system-ui;font-weight:900;
            font-size:10px;color:#fff;cursor:pointer;
          ">ר</div>`,
          className: "train-station-marker", iconSize: [24, 24], iconAnchor: [12, 12],
        });
        const m = L.marker([st.lat, st.lon], { icon, zIndexOffset: -50 })
          .addTo(mapRef.current!)
          .bindTooltip(
            `<div dir="rtl" style="font-family:'Heebo',system-ui;padding:2px 0">
              <b style="font-size:13px">${name}</b><br/>
              <small style="color:#3b82f6">תחנת רכבת ישראל</small>
            </div>`,
            { direction: "top", offset: [0, -8] }
          );
        trainStMarkersRef.current.push(m as unknown as LeafletMarker);
      }
    } catch { /* non-critical */ }
  }, []);

  // ── React to selectedVehicleId from outside (BottomSheet click) ──────────────
  useEffect(() => {
    if (!mapReady) return;
    const id = selectedVehicleId;

    if (!id) {
      // Deselect
      if (prevSelectedIdRef.current !== null) {
        clearRouteDisplay();
        selectedRef.current = null;
        setSelectedDisplay(null);
        prevSelectedIdRef.current = null;
      }
      return;
    }

    if (id === prevSelectedIdRef.current) return;
    prevSelectedIdRef.current = id;

    const tracked = trackedRef.current.get(id);
    if (!tracked || !mapRef.current) return;

    const { vehicle, fromLat, fromLon, toLat, toLon, startTime } = tracked;
    const t = easeOut((performance.now() - startTime) / GLIDE_MS);
    const lat = fromLat + (toLat - fromLat) * t;
    const lon = fromLon + (toLon - fromLon) * t;

    // Set as selected
    selectedRef.current = vehicle;
    setSelectedDisplay(vehicle);

    // Fly to vehicle
    mapRef.current.flyTo([lat, lon], 14, { duration: 1.2 });

    // Show route
    if (vehicle.type === "bus" && vehicle.line_ref) {
      showBusLineRoute(String(vehicle.line_ref));
    } else if (vehicle.type === "train") {
      showTrainRoute();
    } else {
      clearRouteDisplay();
    }
  }, [selectedVehicleId, mapReady, showBusLineRoute, showTrainRoute, clearRouteDisplay]);

  // ── Stop popup ────────────────────────────────────────────────────────────────
  const fetchAndShowStopPopup = useCallback(async (stop: BusStop) => {
    if (!mapRef.current) return;
    const L = (await import("leaflet")).default;

    const popup = L.popup({ offset: [0, -16], maxWidth: 260, className: "stop-arrival-popup" })
      .setLatLng([stop.lat, stop.lon])
      .setContent(
        `<div dir="rtl" style="font-family:'Heebo',system-ui;padding:4px 2px;min-width:180px">` +
        `<b style="font-size:13px;color:#1e1b4b">${stop.name}</b><br/>` +
        `<small style="color:#94a3b8">${stop.city} · תחנה #${stop.code}</small><br/>` +
        `<small style="color:#7c3aed;font-weight:600">טוען נתוני הגעה…</small></div>`
      )
      .openOn(mapRef.current);

    try {
      const r = await fetch(
        `http://localhost:8001/api/buses/station-board?stop_code=${stop.code}&window_hours=1`
      );
      const d = await r.json();
      const arrivals: Array<{
        route_short_name?: string;
        line_ref?: string | number;
        agency_name?: string;
        scheduled_time?: string;
      }> = d.arrivals ?? [];
      const now = Date.now();

      const minsUntil = (iso: string): string => {
        try {
          const diff = Math.round((new Date(iso).getTime() - now) / 60_000);
          if (diff <= 0) return "עכשיו";
          if (diff === 1) return "בעוד דקה";
          if (diff <= 10) return `בעוד ${diff} דקות`;
          return `בעוד ${diff} דק׳`;
        } catch { return "—"; }
      };

      // Use route_short_name (human-readable, e.g. "430") over raw line_ref (e.g. "7929")
      const byLine = new Map<string, string>();
      for (const a of arrivals) {
        const line = String(a.route_short_name || a.line_ref || "");
        if (!line || byLine.has(line)) continue;
        byLine.set(line, a.scheduled_time ? minsUntil(a.scheduled_time) : "—");
        if (byLine.size >= 6) break;
      }

      const rows = byLine.size > 0
        ? [...byLine.entries()].map(([line, eta]) =>
            `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6">` +
            `<div style="display:flex;align-items:center;gap:7px">` +
            `<div style="width:30px;height:30px;background:#16a34a;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:${line.length > 3 ? 9 : 11}px">${line}</div>` +
            `<span style="font-weight:700;color:#1e1b4b;font-size:12px">קו ${line}</span>` +
            `</div>` +
            `<span style="color:#7c3aed;font-weight:700;font-size:11px;white-space:nowrap">${eta}</span>` +
            `</div>`
          ).join("")
        : `<div style="color:#9ca3af;font-size:12px;text-align:center;padding:10px 0">אין יציאות בשעה הקרובה</div>`;

      const content =
        `<div dir="rtl" style="font-family:'Heebo',system-ui;min-width:200px;max-width:260px">` +
        `<div style="font-weight:800;font-size:14px;color:#1e1b4b;margin-bottom:3px">${stop.name}</div>` +
        `<div style="font-size:11px;color:#9ca3af;margin-bottom:10px">${stop.city} · תחנה #${stop.code}</div>` +
        `<div style="font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">קווים עוברים · זמני הגעה</div>` +
        rows +
        `<button data-action="open-station-board" data-stop-code="${stop.code}" style="width:100%;margin-top:10px;padding:7px;background:#f0eeff;border:none;border-radius:8px;color:#7c3aed;font-weight:700;font-size:11px;cursor:pointer;font-family:'Heebo',system-ui">` +
        `לוח יציאות מלא ←</button>` +
        `</div>`;

      popup.setContent(content);

      setTimeout(() => {
        const el = popup.getElement();
        const btn = el?.querySelector<HTMLElement>("[data-action='open-station-board']");
        if (btn) {
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onStopClickRef.current?.(stop.code);
          });
        }
      }, 30);
    } catch {
      popup.setContent(
        `<div dir="rtl" style="font-family:'Heebo',system-ui;padding:8px;color:#c2410c">שגיאה בטעינת נתונים</div>`
      );
    }
  }, []);

  // ── Bus stops (zoom ≥ STOP_MIN_ZOOM, on-demand per viewport) ─────────────────
  const loadStopsForBounds = useCallback(async () => {
    if (!mapRef.current) return;
    if (mapRef.current.getZoom() < STOP_MIN_ZOOM) return;
    const b = mapRef.current.getBounds();
    const key = `${b.getSouth().toFixed(2)},${b.getNorth().toFixed(2)},${b.getWest().toFixed(2)},${b.getEast().toFixed(2)}`;
    if (key === stopsLoadedForRef.current) return;
    stopsLoadedForRef.current = key;
    try {
      const r = await fetch(
        `http://localhost:8001/api/buses/stops?lat_min=${b.getSouth().toFixed(4)}&lat_max=${b.getNorth().toFixed(4)}&lon_min=${b.getWest().toFixed(4)}&lon_max=${b.getEast().toFixed(4)}&limit=150`
      );
      const d = await r.json();
      const stops: BusStop[] = d.stops ?? [];
      const L = (await import("leaflet")).default;
      for (const m of stopMarkersRef.current.values()) m.remove();
      stopMarkersRef.current.clear();
      for (const stop of stops) {
        if (!stop.lat || !stop.lon) continue;
        const icon = L.divIcon({
          html: `<div style="width:26px;height:26px;background:#7c3aed;border:2.5px solid #ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Heebo',system-ui;font-weight:900;font-size:12px;color:#ffffff;box-shadow:0 3px 10px rgba(124,58,237,0.40);cursor:pointer">ב</div>`,
          className: "stop-marker", iconSize: [26, 26], iconAnchor: [13, 13],
        });
        const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: -100 })
          .addTo(mapRef.current!)
          .bindTooltip(
            `<div dir="rtl" style="font-family:'Heebo',system-ui;padding:2px 0"><b style="font-size:13px">${stop.name}</b><br/><small style="color:#94a3b8">${stop.city} · תחנה #${stop.code}</small></div>`,
            { direction: "top", className: "stop-tooltip", offset: [0, -8] }
          )
          .on("click", (e: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(e);
            fetchAndShowStopPopup(stop);
          });
        stopMarkersRef.current.set(stop.code, m);
      }
    } catch { /* non-critical */ }
  }, [fetchAndShowStopPopup]);

  const updateStopVisibility = useCallback(() => {
    if (!mapRef.current) return;
    const show = mapRef.current.getZoom() >= STOP_MIN_ZOOM;
    for (const m of stopMarkersRef.current.values()) {
      if (show) m.addTo(mapRef.current!); else m.remove();
    }
  }, []);

  // ── Init Leaflet ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || mapRef.current || !containerRef.current) return;
    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      const map = L.map(containerRef.current!, {
        center: ISRAEL_CENTER, zoom: INITIAL_ZOOM,
        zoomControl: false, preferCanvas: true,
        // Smooth drag & pinch-to-zoom — no jump/reset when vehicle data arrives
        dragging: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(({ tap: false } as any)),   // disable ghost tap (mobile) — not in TS types
        bounceAtZoomLimits: false,  // stop the elastic "bounce" at min/max zoom
        fadeAnimation: false,       // prevents tile flash on zoom that looks like a crash
        markerZoomAnimation: false, // prevent marker jump during zoom animation
      });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd", maxZoom: 20,
      }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      mapRef.current = map;
      setMapReady(true);
    })();
    return () => {
      cancelAnimationFrame(rafRef.current);
      focusCircleRef.current?.remove();
      routePolylineRef.current?.remove();
      routeLineRef.current?.remove();
      for (const m of routeStopMarkersRef.current) m.remove();
      for (const m of trainStMarkersRef.current) m.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      trackedRef.current.clear();
      stopMarkersRef.current.clear();
      setMapReady(false);
    };
  }, []);

  // ── Canvas rAF render loop ────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    const resize = () => {
      const canvas = canvasRef.current, outer = outerRef.current;
      if (!canvas || !outer) return;
      canvas.width = outer.clientWidth;
      canvas.height = outer.clientHeight;
    };

    const renderFrame = () => {
      const canvas = canvasRef.current;
      if (!canvas || !mapRef.current) return;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      const now  = performance.now();
      const lmap = mapRef.current;
      const sel  = selectedRef.current;
      const zoom = lmap.getZoom();

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const [, tracked] of trackedRef.current) {
        const { vehicle: v, fromLat, fromLon, toLat, toLon, startTime } = tracked;
        const layerKey = v.type === "train" ? "trains" : v.type === "bus" ? "buses" : "flights";
        if (!layersRef.current[layerKey]) continue;
        const t = easeOut((now - startTime) / GLIDE_MS);
        const lat = fromLat + (toLat - fromLat) * t;
        const lon = fromLon + (toLon - fromLon) * t;
        try {
          const pt = lmap.latLngToContainerPoint([lat, lon]);
          const heading = (v.heading as number | undefined) ?? (v.bearing as number | undefined) ?? 0;
          drawVehicle(ctx, pt.x, pt.y, v.type, heading, sel?.id === v.id, now);
          if (zoom >= LABEL_MIN_ZOOM) drawLabel(ctx, pt.x, pt.y, v);
        } catch { /* skip off-map */ }
      }
      rafRef.current = requestAnimationFrame(renderFrame);
    };

    resize();
    map.on("resize", resize);
    rafRef.current = requestAnimationFrame(renderFrame);
    return () => { cancelAnimationFrame(rafRef.current); map.off("resize", resize); };
  }, [mapReady]);

  // ── Map events ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    const onMapClick = (e: { containerPoint: { x: number; y: number } }) => {
      const { x: cx, y: cy } = e.containerPoint;
      const now = performance.now();
      let closest: Vehicle | null = null;
      let closestDist = HIT_RADIUS;
      for (const [, tracked] of trackedRef.current) {
        const { vehicle: v, fromLat, fromLon, toLat, toLon, startTime } = tracked;
        const t = easeOut((now - startTime) / GLIDE_MS);
        const lat = fromLat + (toLat - fromLat) * t;
        const lon = fromLon + (toLon - fromLon) * t;
        try {
          const pt = map.latLngToContainerPoint([lat, lon]);
          const dist = Math.sqrt((pt.x - cx) ** 2 + (pt.y - cy) ** 2);
          if (dist < closestDist) { closestDist = dist; closest = v; }
        } catch { /* skip */ }
      }
      selectedRef.current = closest;
      setSelectedDisplay(closest);
      onVehicleSelectRef.current?.(closest);

      // Show route for clicked vehicle
      if (closest) {
        if (closest.type === "bus" && closest.line_ref) {
          showBusLineRoute(String(closest.line_ref));
        } else if (closest.type === "train") {
          showTrainRoute();
        } else {
          clearRouteDisplay();
        }
      } else {
        clearRouteDisplay();
      }
    };

    const onMoveEnd = async () => {
      if (focusModeRef.current && focusCircleRef.current) {
        const c = map.getCenter();
        focusCircleRef.current.setLatLng([c.lat, c.lng]);
      }
      const buses  = await fetchBuses();
      let others = vehiclesRef.current.filter((v) => v.type !== "bus");
      // Tiberias has no rail — drop train markers when focused there
      const mc = map.getCenter();
      if (focusModeRef.current && isInTiberias(mc.lat, mc.lng)) {
        others = others.filter((v) => v.type !== "train");
      }
      updateVehicles([...others, ...buses]);
      updateStopVisibility();
      loadStopsForBounds();

      // In focus mode, also refresh train stations
      if (focusModeRef.current) loadTrainStationsForFocus();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on("click", onMapClick as any);
    map.on("moveend", onMoveEnd);
    map.on("zoomend", () => { updateStopVisibility(); loadStopsForBounds(); });

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.off("click", onMapClick as any);
      map.off("moveend", onMoveEnd);
      map.off("zoomend", updateStopVisibility);
    };
  }, [mapReady, fetchBuses, updateVehicles, updateStopVisibility,
      loadStopsForBounds, showBusLineRoute, showTrainRoute, clearRouteDisplay,
      loadTrainStationsForFocus]);

  // ── 15 s auto-refresh ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    fetchAll();
    const id = setInterval(fetchAll, 15_000);
    return () => clearInterval(id);
  }, [fetchAll, mapReady]);

  // ── Load train stations when focus mode activates ────────────────────────────
  useEffect(() => {
    if (!mapReady || !focusMode) return;
    loadTrainStationsForFocus();
  }, [focusMode, mapReady, loadTrainStationsForFocus]);

  // ── Locate Me ────────────────────────────────────────────────────────────────
  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation || !mapRef.current) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        mapRef.current!.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 1.5 });
        onFocusModeChange?.(true);
      },
      () => { setLocating(false); }
    );
  }, [onFocusModeChange]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div ref={outerRef} className="map-root relative w-full h-full">
      {/* touchAction:none lets Leaflet own all touch gestures (drag, pinch-to-zoom) */}
      <div ref={containerRef} className="w-full h-full" style={{ pointerEvents: "auto", touchAction: "none" }} />

      <canvas ref={canvasRef} className="absolute inset-0" style={{ pointerEvents: "none" }} />

      {/* ── Map overlay buttons (top-right) ── */}
      <div className="absolute z-[1000] flex flex-col gap-2" style={{ top: 12, right: 12 }}>
        <button
          onClick={handleLocateMe}
          disabled={locating}
          title="עבור למיקומי והפעל מצב מיקוד"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold shadow-lg transition-all"
          style={{
            background: "#ffffffee", border: "1.5px solid #ddd6fe",
            color: locating ? "#9ca3af" : "#7c3aed",
            boxShadow: "0 2px 12px rgba(124,58,237,0.14)",
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => !locating && (e.currentTarget.style.borderColor = "#7c3aed")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#ddd6fe")}
        >
          <Navigation size={13} className={locating ? "animate-pulse" : ""} />
          {locating ? "מאתר…" : "אתר אותי"}
        </button>

        <button
          onClick={() => onFocusModeChange?.(!focusMode)}
          title={focusMode ? "יציאה ממצב מיקוד 1 ק\"מ" : "הפעל מצב מיקוד 1 ק\"מ"}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold shadow-lg transition-all"
          style={{
            background: focusMode ? "#7c3aed" : "#ffffffee",
            border: `1.5px solid ${focusMode ? "#7c3aed" : "#ddd6fe"}`,
            color: focusMode ? "#ffffff" : "#9ca3af",
            boxShadow: focusMode ? "0 2px 12px rgba(124,58,237,0.35)" : "0 2px 12px rgba(124,58,237,0.10)",
            fontFamily: "inherit",
          }}
        >
          <Target size={13} />
          {focusMode ? 'מיקוד 1 ק"מ ✓' : 'מצב מיקוד'}
        </button>
      </div>

      {/* ── Route info banner ── */}
      {routeInfo && (
        <div
          className="absolute z-[1000] flex items-center gap-2"
          style={{
            top: 12, left: 12,
            background: "#ffffffee", border: "1.5px solid #ddd6fe",
            borderRadius: 12, padding: "7px 12px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.10)",
            fontFamily: "inherit",
          }}
          dir="rtl"
        >
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#16a34a" }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#1e1b4b" }}>
            קו {routeInfo.line} · {routeInfo.stopCount} תחנות
          </span>
          <button
            onClick={() => { clearRouteDisplay(); onVehicleSelect?.(null); }}
            style={{
              width: 18, height: 18, borderRadius: "50%", border: "none",
              background: "#f0eeff", color: "#7c3aed", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700,
            }}
          >×</button>
        </div>
      )}

      {/* ── Service Unavailable banner (shown only when Ministry API is down) ── */}
      {backendOffline && !loading && (
        <div style={{
          position: "absolute", bottom: 180, left: "50%",
          transform: "translateX(-50%)", zIndex: 1100,
          background: "#fff7ed", border: "1.5px solid #fbbf24",
          borderRadius: 14, padding: "12px 20px",
          boxShadow: "0 4px 20px rgba(251,191,36,0.20)",
          display: "flex", alignItems: "center", gap: 10,
          fontFamily: "inherit", whiteSpace: "nowrap",
        }} dir="rtl">
          <span style={{ fontSize: 18 }}>🚌</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#b45309" }}>
              השירות זמנית אינו זמין
            </div>
            <div style={{ fontSize: 11, color: "#92400e", marginTop: 2 }}>
              Service Temporarily Unavailable · נסה שוב בקרוב
            </div>
          </div>
        </div>
      )}

      {selectedDisplay && (
        <VehiclePopup
          vehicle={selectedDisplay}
          onClose={() => {
            selectedRef.current = null;
            setSelectedDisplay(null);
            onVehicleSelectRef.current?.(null);
            clearRouteDisplay();
          }}
        />
      )}

      {loading && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 z-[1001] px-3 py-1.5 rounded-full text-xs flex items-center gap-2"
          style={{ background: "#ffffffee", border: "1.5px solid #ddd6fe", color: "#7c3aed", boxShadow: "0 2px 12px rgba(124,58,237,0.12)", fontFamily: "inherit" }}
        >
          <div className="w-3 h-3 rounded-full animate-spin" style={{ border: "2px solid #ddd6fe", borderTopColor: "#7c3aed" }} />
          {focusMode ? 'טוען אזור 1 ק"מ…' : "טוען נתונים חיים…"}
        </div>
      )}

      {/* Legend */}
      <div
        className="absolute bottom-16 left-4 z-[1000] rounded-2xl p-3 text-xs space-y-1.5"
        style={{ background: "#ffffffee", border: "1.5px solid #ddd6fe", boxShadow: "0 2px 12px rgba(124,58,237,0.10)", fontFamily: "inherit" }}
        dir="rtl"
      >
        {(["train", "bus", "flight"] as const).map((type) => {
          const labelHe = type === "train" ? "רכבת" : type === "bus" ? "אוטובוס" : "טיסה";
          return (
            <div key={type} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[type] }} />
              <span style={{ color: "#6b7280" }}>{labelHe}</span>
            </div>
          );
        })}
        {vehicleCount > 0 && (
          <div className="border-t pt-1.5 font-mono" style={{ borderColor: "#ede9fe", color: "#9ca3af" }}>
            {vehicleCount} חיים
            {focusMode && <span style={{ color: "#7c3aed" }}> · 1 ק"מ</span>}
          </div>
        )}
        <div style={{ color: "#d1d5db", fontSize: "10px" }}>
          זום ≥{STOP_MIN_ZOOM} → תחנות · ≥{LABEL_MIN_ZOOM} → תוויות
        </div>
      </div>
    </div>
  );
}
