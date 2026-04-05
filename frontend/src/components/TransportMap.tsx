"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, ZoomControl } from "react-leaflet";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Layers } from "./Dashboard";

// ── Types ─────────────────────────────────────────────────────────────────────
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
  lat: number;
  lon: number;
  dist_m: number;
}

interface TrackedVehicle {
  vehicle: Vehicle;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  startTime: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CENTER: [number, number] = [32.7922, 35.5312]; // Tiberias
const ZOOM = 17;
const GLIDE_MS = 8000;
const COLORS = { train: "#2563eb", bus: "#16a34a", flight: "#d97706" };
const API = "http://localhost:8001";

// ── Canvas helpers ────────────────────────────────────────────────────────────
function easeOut(t: number) { return 1 - (1 - Math.min(t, 1)) ** 3; }

function rRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
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
  isLive: boolean = true,
) {
  const color = COLORS[type];

  if (isLive) {
    const phase = (now % 2000) / 2000;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 0.6 - phase * 0.6);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14 + phase * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((headingDeg * Math.PI) / 180);
  ctx.shadowBlur = isSelected ? 24 : 8;
  ctx.shadowColor = color + "cc";

  if (type === "bus") {
    ctx.fillStyle = color;
    rRect(ctx, -6, -10, 12, 20, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(-5, -8, 4, 4); ctx.fillRect(1, -8, 4, 4);
    ctx.fillRect(-5, -2, 4, 4); ctx.fillRect(1, -2, 4, 4);
    ctx.fillStyle = "rgba(0,0,0,0.30)"; ctx.fillRect(-4, 5, 8, 3);
    ctx.strokeStyle = "rgba(255,255,255,0.80)"; ctx.lineWidth = 1.5;
    rRect(ctx, -6, -10, 12, 20, 3); ctx.stroke();
  } else if (type === "train") {
    ctx.fillStyle = color;
    rRect(ctx, -5, -11, 10, 22, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.40)";
    ctx.fillRect(-4, -9, 3, 4); ctx.fillRect(1, -9, 3, 4);
    ctx.fillRect(-4, -3, 3, 4); ctx.fillRect(1, -3, 3, 4);
    ctx.fillRect(-3, 5, 6, 4);
    ctx.strokeStyle = "rgba(255,255,255,0.80)"; ctx.lineWidth = 1.5;
    rRect(ctx, -5, -11, 10, 22, 3); ctx.stroke();
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
  ctx.restore();
}

// ── Inner map component (inside MapContainer, has useMap access) ──────────────
function MapContent({
  layers,
  onStopClick,
  onVehiclesUpdate,
  trackedRef,
  layersRef,
  onMapReady,
}: {
  layers: Layers;
  onStopClick?: (code: number) => void;
  onVehiclesUpdate?: (v: Vehicle[]) => void;
  trackedRef: React.MutableRefObject<Map<string, TrackedVehicle>>;
  layersRef: React.MutableRefObject<Layers>;
  onMapReady: (map: L.Map) => void;
}) {
  const map = useMap();
  const [stops, setStops] = useState<BusStop[]>([]);
  const onVehiclesUpdateRef = useRef(onVehiclesUpdate);
  const onStopClickRef = useRef(onStopClick);

  useEffect(() => { onVehiclesUpdateRef.current = onVehiclesUpdate; }, [onVehiclesUpdate]);
  useEffect(() => { onStopClickRef.current = onStopClick; }, [onStopClick]);

  // Expose map instance to parent
  useEffect(() => { onMapReady(map); }, [map, onMapReady]);

  // Fetch all bus stops within 500m of Tiberias centre
  useEffect(() => {
    fetch(`${API}/api/buses/nearby-stops?lat=32.7922&lon=35.5312&radius_km=0.5`)
      .then(r => r.json())
      .then(d => {
        const s: BusStop[] = d.stops ?? [];
        console.log(`[TransportMap] Loaded ${s.length} nearby stops`);
        setStops(s);
      })
      .catch(err => console.warn("[TransportMap] stop fetch failed:", err));
  }, []);

  // Fetch live vehicles and update trackedRef for canvas rendering
  const fetchVehicles = useCallback(async () => {
    const b = map.getBounds();
    const vehicles: Vehicle[] = [];

    await Promise.allSettled([
      layersRef.current.buses
        ? fetch(
            `${API}/api/buses/live` +
            `?lat_min=${b.getSouth().toFixed(4)}&lat_max=${b.getNorth().toFixed(4)}` +
            `&lon_min=${b.getWest().toFixed(4)}&lon_max=${b.getEast().toFixed(4)}&limit=200`,
          )
            .then(r => r.json())
            .then(d => d.buses?.forEach((v: Vehicle) => vehicles.push({ ...v, type: "bus" })))
        : Promise.resolve(),

      layersRef.current.trains
        ? fetch(`${API}/api/trains/live`)
            .then(r => r.json())
            .then(d => d.trains?.forEach((v: Vehicle) => vehicles.push({ ...v, type: "train" })))
        : Promise.resolve(),

      layersRef.current.flights
        ? fetch(`${API}/api/flights/live`)
            .then(r => r.json())
            .then(d => d.flights?.forEach((v: Vehicle) => vehicles.push({ ...v, type: "flight" })))
        : Promise.resolve(),
    ]);

    const now = performance.now();
    const activeIds = new Set(vehicles.map(v => v.id));
    for (const id of trackedRef.current.keys()) {
      if (!activeIds.has(id)) trackedRef.current.delete(id);
    }
    for (const v of vehicles) {
      const ex = trackedRef.current.get(v.id);
      if (ex) {
        const t = easeOut((now - ex.startTime) / GLIDE_MS);
        const cLat = ex.fromLat + (ex.toLat - ex.fromLat) * t;
        const cLon = ex.fromLon + (ex.toLon - ex.fromLon) * t;
        trackedRef.current.set(v.id, {
          vehicle: v, fromLat: cLat, fromLon: cLon,
          toLat: v.lat, toLon: v.lon, startTime: now,
        });
      } else {
        trackedRef.current.set(v.id, {
          vehicle: v, fromLat: v.lat, fromLon: v.lon,
          toLat: v.lat, toLon: v.lon, startTime: now,
        });
      }
    }
    onVehiclesUpdateRef.current?.(vehicles);
  }, [map, trackedRef, layersRef]);

  useEffect(() => {
    fetchVehicles();
    const id = setInterval(fetchVehicles, 15_000);
    return () => clearInterval(id);
  }, [fetchVehicles]);

  // Build stop icon (stable reference)
  const stopIcon = L.divIcon({
    html: `<div style="
      width:30px;height:30px;
      background:#16a34a;
      border:3px solid #ffffff;
      border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font-family:'Heebo',system-ui;font-weight:900;font-size:13px;
      color:#ffffff;
      box-shadow:0 3px 14px rgba(22,163,74,0.55);
      cursor:pointer;
    ">ב</div>`,
    className: "stop-marker",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  return (
    <>
      {stops.length === 0 && (
        // When stops haven't loaded yet, render nothing — canvas still works
        null
      )}
      {stops.map(stop => (
        <Marker
          key={stop.code}
          position={[stop.lat, stop.lon]}
          icon={stopIcon}
          eventHandlers={{
            click: () => {
              console.log(`[TransportMap] Stop clicked: ${stop.code} — ${stop.name}`);
              onStopClickRef.current?.(stop.code);
            },
          }}
        />
      ))}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function TransportMap({
  layers,
  onStopClick,
  onVehiclesUpdate,
  // Props kept for Dashboard compatibility (not all implemented in this focused build)
  focusMode: _focusMode = false,
  lineFilter: _lineFilter = "",
  routeCoords: _routeCoords = [],
  onFocusModeChange: _onFocusModeChange,
  selectedVehicleId: _selectedVehicleId = null,
  onVehicleSelect: _onVehicleSelect,
  globalView: _globalView = false,
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
  const outerRef    = useRef<HTMLDivElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const mapRef      = useRef<L.Map | null>(null);
  const trackedRef  = useRef<Map<string, TrackedVehicle>>(new Map());
  const rafRef      = useRef(0);
  const layersRef   = useRef<Layers>(layers);

  useEffect(() => { layersRef.current = layers; }, [layers]);

  const handleMapReady = useCallback((map: L.Map) => {
    mapRef.current = map;
  }, []);

  // Sync canvas size to outer container
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const obs = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width  = outer.clientWidth;
      canvas.height = outer.clientHeight;
    });
    obs.observe(outer);
    return () => obs.disconnect();
  }, []);

  // Canvas rAF vehicle render loop
  useEffect(() => {
    const renderFrame = () => {
      const canvas = canvasRef.current;
      const map = mapRef.current;
      if (!canvas || !map) {
        rafRef.current = requestAnimationFrame(renderFrame);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(renderFrame); return; }

      const now = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const [, tracked] of trackedRef.current) {
        const { vehicle: v, fromLat, fromLon, toLat, toLon, startTime } = tracked;
        const lk = v.type === "train" ? "trains" : v.type === "bus" ? "buses" : "flights";
        if (!layersRef.current[lk]) continue;
        const t   = easeOut((now - startTime) / GLIDE_MS);
        const lat = fromLat + (toLat - fromLat) * t;
        const lon = fromLon + (toLon - fromLon) * t;
        try {
          const pt = map.latLngToContainerPoint([lat, lon]);
          drawVehicle(
            ctx, pt.x, pt.y, v.type,
            (v.bearing as number | undefined) ?? (v.heading as number | undefined) ?? 0,
            false, now,
            (v.is_live as boolean | undefined) ?? true,
          );
        } catch { /* point off screen */ }
      }

      rafRef.current = requestAnimationFrame(renderFrame);
    };

    rafRef.current = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div ref={outerRef} style={{ position: "relative", width: "100%", height: "100%" }}>
      <MapContainer
        center={CENTER}
        zoom={ZOOM}
        style={{ width: "100%", height: "100%" }}
        zoomControl={false}
        preferCanvas={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          maxZoom={20}
          subdomains="abcd"
        />
        <ZoomControl position="bottomright" />

        <MapContent
          layers={layers}
          onStopClick={onStopClick}
          onVehiclesUpdate={onVehiclesUpdate}
          trackedRef={trackedRef}
          layersRef={layersRef}
          onMapReady={handleMapReady}
        />
      </MapContainer>

      {/* Canvas overlay — vehicle silhouettes drawn here, pointer-events:none so map stays interactive */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 500,
        }}
      />
    </div>
  );
}
