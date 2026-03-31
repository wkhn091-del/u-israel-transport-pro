"use client";
import { useState } from "react";
import { MapPin, Navigation, Search, X, Clock, Ruler, Loader2 } from "lucide-react";

interface RouteResult {
  coordinates: [number, number][];
  distance_km: number;
  duration_min: number;
}

interface RoutePlannerProps {
  onRouteFound: (coords: [number, number][]) => void;
  onClose: () => void;
}

const CITY_PRESETS = [
  "Tel Aviv", "Jerusalem", "Haifa", "Beer Sheva", "Eilat", "Netanya",
];

async function geocodeIsrael(query: string): Promise<[number, number] | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query + ", Israel")}` +
      `&countrycodes=il&format=json&limit=1`;
    const r = await fetch(url, {
      headers: { "Accept-Language": "en", "User-Agent": "IsraelTransportPro/1.0" },
    });
    const data = await r.json();
    if (data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
  } catch { /* ignore */ }
  return null;
}

export default function RoutePlanner({ onRouteFound, onClose }: RoutePlannerProps) {
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [result, setResult] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const planRoute = async () => {
    const o = origin.trim();
    const d = dest.trim();
    if (!o || !d) return;

    setLoading(true);
    setError("");
    setResult(null);

    const [from, to] = await Promise.all([geocodeIsrael(o), geocodeIsrael(d)]);

    if (!from || !to) {
      setError(
        !from && !to
          ? "Could not locate either address."
          : !from
          ? `Could not find "${o}". Try a city name.`
          : `Could not find "${d}". Try a city name.`
      );
      setLoading(false);
      return;
    }

    try {
      const r = await fetch(
        `http://localhost:8001/api/routing/plan` +
          `?from_lat=${from[0]}&from_lon=${from[1]}` +
          `&to_lat=${to[0]}&to_lon=${to[1]}`
      );
      const data = await r.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data as RouteResult);
        onRouteFound(data.coordinates);
      }
    } catch {
      setError("Routing service unavailable.");
    }
    setLoading(false);
  };

  const handlePreset = (city: string) => {
    if (!origin) setOrigin(city);
    else if (!dest) setDest(city);
    else setDest(city);
  };

  return (
    <div
      className="absolute top-4 left-4 z-[700] rounded-2xl shadow-2xl flex flex-col"
      style={{
        width: 300,
        background: "#0f1623",
        border: "1px solid #253047",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: "#1e293b" }}
      >
        <div className="flex items-center gap-2">
          <Navigation size={15} style={{ color: "#a78bfa" }} />
          <span className="font-bold text-sm" style={{ color: "#e2e8f0" }}>
            Route Planner
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg transition-colors"
          style={{ color: "#64748b" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
        >
          <X size={15} />
        </button>
      </div>

      {/* Inputs */}
      <div className="p-3 space-y-2">
        {/* Origin */}
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2.5"
          style={{ background: "#161f30", border: "1px solid #253047" }}
        >
          <MapPin size={13} style={{ color: "#22c55e", flexShrink: 0 }} />
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && planRoute()}
            placeholder="Origin (e.g. Tel Aviv)"
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "#e2e8f0" }}
          />
          {origin && (
            <button onClick={() => setOrigin("")}>
              <X size={11} style={{ color: "#475569" }} />
            </button>
          )}
        </div>

        {/* Connector line */}
        <div className="flex items-center gap-2 px-3">
          <div
            className="w-px ml-[5px] h-3"
            style={{ background: "#253047" }}
          />
        </div>

        {/* Destination */}
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2.5"
          style={{ background: "#161f30", border: "1px solid #253047" }}
        >
          <Navigation size={13} style={{ color: "#f59e0b", flexShrink: 0 }} />
          <input
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && planRoute()}
            placeholder="Destination (e.g. Jerusalem)"
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "#e2e8f0" }}
          />
          {dest && (
            <button onClick={() => setDest("")}>
              <X size={11} style={{ color: "#475569" }} />
            </button>
          )}
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {CITY_PRESETS.map((city) => (
            <button
              key={city}
              onClick={() => handlePreset(city)}
              className="px-2.5 py-1 rounded-lg text-xs transition-all"
              style={{
                background: "#161f30",
                border: "1px solid #253047",
                color: "#64748b",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#e2e8f0";
                e.currentTarget.style.borderColor = "#a78bfa66";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#64748b";
                e.currentTarget.style.borderColor = "#253047";
              }}
            >
              {city}
            </button>
          ))}
        </div>

        {/* Plan button */}
        <button
          onClick={planRoute}
          disabled={loading || !origin.trim() || !dest.trim()}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-opacity"
          style={{
            background: "linear-gradient(135deg, #a78bfa, #7c3aed)",
            color: "#fff",
            opacity: loading || !origin.trim() || !dest.trim() ? 0.5 : 1,
          }}
        >
          {loading ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Planning…
            </>
          ) : (
            <>
              <Search size={14} />
              Plan Route
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 pb-3 text-xs" style={{ color: "#f87171" }}>
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className="px-4 pb-4 pt-3 border-t"
          style={{ borderColor: "#1e293b" }}
        >
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <Clock size={13} style={{ color: "#a78bfa" }} />
              <span className="text-sm font-bold" style={{ color: "#e2e8f0" }}>
                {result.duration_min} min
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Ruler size={13} style={{ color: "#a78bfa" }} />
              <span className="text-sm font-bold" style={{ color: "#e2e8f0" }}>
                {result.distance_km} km
              </span>
            </div>
          </div>
          <p className="mt-1.5 text-xs" style={{ color: "#475569" }}>
            Route shown on map · tap vehicles to inspect
          </p>
          <button
            onClick={() => {
              setResult(null);
              onRouteFound([]);
            }}
            className="mt-2 text-xs"
            style={{ color: "#64748b" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
          >
            Clear route ×
          </button>
        </div>
      )}
    </div>
  );
}
