"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Search, X, Bus, Clock, RefreshCw, MapPin,
  ChevronRight, AlertCircle, Loader2,
} from "lucide-react";

interface Stop {
  id: number;
  code: number;
  name: string;
  city: string;
  lat: number | null;
  lon: number | null;
}

interface Arrival {
  ride_id: number;
  journey_ref: string;
  line_ref: number | null;
  route_short_name: string | null;  // human-readable line number, e.g. "430"
  agency_name: string | null;        // operator name string, e.g. "אגד"
  operator: number | null;
  scheduled_time: string;
  scheduled_display: string;         // pre-formatted Israel local time from backend
  vehicle_ref: string | null;
}

interface BoardData {
  stop_code: number;
  stop_name: string;
  stop_city: string;
  stop_lat: number | null;
  stop_lon: number | null;
  arrivals: Arrival[];
  error?: string;
}

const API = "http://localhost:8001/api/buses";

const OPERATOR_NAMES: Record<number, string> = {
  3:  "Egged",
  5:  "Dan",
  7:  "Metropoline",
  14: "Nateev Express",
  15: "Superbus",
  16: "Afikim",
  18: "Kavim",
  25: "Egged Taavura",
};

export default function StationBoard({
  initialStopCode,
  onClose,
}: {
  initialStopCode: number | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cityQuery, setCityQuery] = useState("");
  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Auto-load if a stop code was passed from map click ─────────────────
  useEffect(() => {
    if (!initialStopCode) return;
    loadBoard(initialStopCode);
  }, [initialStopCode]); // eslint-disable-line

  // ── Stop search ────────────────────────────────────────────────────────
  const searchStops = useCallback(async () => {
    if (!cityQuery.trim() && !query.trim()) return;
    setStopsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "40" });
      if (cityQuery.trim()) params.append("city", cityQuery.trim());
      if (/^\d+$/.test(query.trim())) params.append("code", query.trim());
      const r = await fetch(`${API}/stops?${params}`);
      const d = await r.json();
      setStops(d.stops ?? []);
    } catch {
      setStops([]);
    } finally {
      setStopsLoading(false);
    }
  }, [cityQuery, query]);

  // ── Board fetch ─────────────────────────────────────────────────────────
  const loadBoard = useCallback(async (stopCode: number) => {
    setBoardLoading(true);
    setBoard(null);
    try {
      const r = await fetch(`${API}/station-board?stop_code=${stopCode}&window_hours=2`);
      const d: BoardData = await r.json();
      setBoard(d);
      setLastRefresh(new Date().toLocaleTimeString("he-IL"));
    } catch {
      setBoard({ stop_code: stopCode, stop_name: `Stop ${stopCode}`, stop_city: "", stop_lat: null, stop_lon: null, arrivals: [], error: "Network error" });
    } finally {
      setBoardLoading(false);
    }
  }, []);

  // ── Auto-refresh board every 60s ─────────────────────────────────────
  useEffect(() => {
    if (!selectedStop) return;
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(() => loadBoard(selectedStop.code), 60_000);
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, [selectedStop, loadBoard]);

  const handleStopSelect = (stop: Stop) => {
    setSelectedStop(stop);
    setStops([]);
    setQuery("");
    loadBoard(stop.code);
  };

  // ── Time helpers ─────────────────────────────────────────────────────
  const minutesUntil = (isoTime: string): number => {
    try {
      const t = new Date(isoTime).getTime();
      return Math.round((t - Date.now()) / 60000);
    } catch { return 0; }
  };

  const arrivalColor = (mins: number) => {
    if (mins < 0)   return "#475569";
    if (mins <= 5)  return "#ef4444";
    if (mins <= 15) return "#f59e0b";
    return "#22c55e";
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: "#080d18" }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-5 py-4 border-b flex-shrink-0"
        style={{ background: "#0f1623", borderColor: "#253047" }}>
        <div className="p-2 rounded-xl" style={{ background: "#22c55e18", border: "1px solid #22c55e33" }}>
          <Bus size={18} style={{ color: "#22c55e" }} />
        </div>
        <div>
          <div className="font-bold text-white text-sm">Station Board</div>
          <div className="text-xs" style={{ color: "#475569" }}>
            {selectedStop
              ? `${selectedStop.name} · ${selectedStop.city}`
              : "Search for a bus stop"}
          </div>
        </div>
        <button onClick={onClose} className="ml-auto p-1.5 rounded-lg transition-colors"
          style={{ color: "#475569" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}>
          <X size={16} />
        </button>
      </div>

      {/* ── Search ── */}
      <div className="px-4 py-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#475569" }} />
            <input
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchStops()}
              placeholder="City (e.g. תל אביב)"
              className="w-full pl-8 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "#161f30",
                border: "1px solid #253047",
                color: "#e2e8f0",
              }}
            />
          </div>
          <div className="relative w-28">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchStops()}
              placeholder="Stop code"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "#161f30",
                border: "1px solid #253047",
                color: "#e2e8f0",
              }}
            />
          </div>
          <button
            onClick={searchStops}
            className="px-3 py-2 rounded-lg text-sm font-medium transition-colors flex-shrink-0"
            style={{ background: "#22c55e22", color: "#22c55e", border: "1px solid #22c55e44" }}
          >
            {stopsLoading ? <Loader2 size={14} className="animate-spin" /> : "Search"}
          </button>
        </div>

        {/* Stop results dropdown */}
        {stops.length > 0 && (
          <div className="mt-2 rounded-xl overflow-hidden border max-h-48 overflow-y-auto"
            style={{ background: "#0f1623", borderColor: "#253047" }}>
            {stops.map((stop) => (
              <button
                key={stop.code}
                onClick={() => handleStopSelect(stop)}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm transition-colors"
                style={{ borderBottom: "1px solid #1e293b", color: "#cbd5e1" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#161f30")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
              >
                <MapPin size={13} style={{ color: "#22c55e", flexShrink: 0 }} />
                <span className="flex-1 truncate">{stop.name}</span>
                <span className="text-xs" style={{ color: "#475569" }}>{stop.city}</span>
                <span className="text-xs font-mono" style={{ color: "#334155" }}>#{stop.code}</span>
                <ChevronRight size={12} style={{ color: "#334155", flexShrink: 0 }} />
              </button>
            ))}
          </div>
        )}
        {stops.length === 0 && !stopsLoading && cityQuery && (
          <div className="mt-2 text-xs text-center py-2" style={{ color: "#475569" }}>
            No stops found — try a different city name
          </div>
        )}
      </div>

      {/* ── Board content ── */}
      <div className="flex-1 overflow-y-auto">
        {boardLoading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 size={28} className="animate-spin" style={{ color: "#22c55e" }} />
            <span className="text-sm" style={{ color: "#475569" }}>Loading departures…</span>
          </div>
        )}

        {!boardLoading && board && (
          <>
            {/* Stop info card */}
            <div className="mx-4 mt-4 p-3 rounded-xl" style={{ background: "#0f1623", border: "1px solid #253047" }}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-sm text-white">{board.stop_name}</div>
                  <div className="text-xs mt-0.5" style={{ color: "#475569" }}>
                    {board.stop_city && <span>{board.stop_city} · </span>}
                    <span className="font-mono">#{board.stop_code}</span>
                  </div>
                  {board.stop_lat && (
                    <div className="text-xs mt-0.5 font-mono" style={{ color: "#334155" }}>
                      {board.stop_lat.toFixed(4)}, {board.stop_lon?.toFixed(4)}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => loadBoard(board.stop_code)}
                  className="p-1.5 rounded-lg transition-colors"
                  style={{ color: "#475569", background: "#161f30" }}
                  title="Refresh"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {lastRefresh && (
                <div className="flex items-center gap-1 mt-2" style={{ color: "#334155" }}>
                  <Clock size={11} />
                  <span className="text-xs">Updated {lastRefresh} · auto-refresh every 60s</span>
                </div>
              )}
            </div>

            {/* Error state */}
            {board.error && (
              <div className="mx-4 mt-3 p-3 rounded-xl flex items-center gap-2"
                style={{ background: "#ef444415", border: "1px solid #ef444433", color: "#ef4444" }}>
                <AlertCircle size={14} />
                <span className="text-xs">{board.error}</span>
              </div>
            )}

            {/* Departure rows */}
            {board.arrivals.length === 0 && !board.error && (
              <div className="mx-4 mt-3 p-4 rounded-xl text-center"
                style={{ background: "#0f1623", border: "1px dashed #253047", color: "#475569" }}>
                <Bus size={24} className="mx-auto mb-2 opacity-40" />
                <div className="text-sm">No scheduled departures in the next 2 hours</div>
              </div>
            )}

            {board.arrivals.length > 0 && (
              <div className="mx-4 mt-3 mb-6 rounded-xl overflow-hidden border"
                style={{ borderColor: "#253047" }}>
                {/* Table header */}
                <div className="grid grid-cols-4 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                  style={{ background: "#0f1623", color: "#475569", borderBottom: "1px solid #1e293b" }}>
                  <span>Line</span>
                  <span>Operator</span>
                  <span>Scheduled</span>
                  <span className="text-right">In</span>
                </div>

                {board.arrivals.map((a, i) => {
                  const mins = minutesUntil(a.scheduled_time);
                  const color = arrivalColor(mins);
                  const departed = mins < -1;
                  // Prefer route_short_name (e.g. "430") over raw line_ref (e.g. "7929")
                  const lineLabel = a.route_short_name || (a.line_ref != null ? String(a.line_ref) : "?");
                  // Prefer agency_name string over numeric operator lookup
                  const operatorLabel = a.agency_name || (a.operator ? (OPERATOR_NAMES[a.operator] ?? `Op ${a.operator}`) : "—");
                  return (
                    <div
                      key={a.ride_id ?? i}
                      className="grid grid-cols-4 items-center px-3 py-3 text-sm"
                      style={{
                        background: i % 2 === 0 ? "#080d18" : "#0a0f1e",
                        borderBottom: "1px solid #0f1623",
                        opacity: departed ? 0.4 : 1,
                      }}
                    >
                      {/* Line */}
                      <div className="flex items-center gap-1.5">
                        <div className="w-8 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
                          style={{ background: "#22c55e22", color: "#22c55e", border: "1px solid #22c55e33", minWidth: 28, padding: "0 3px" }}>
                          {lineLabel}
                        </div>
                      </div>

                      {/* Operator */}
                      <div className="text-xs truncate" style={{ color: "#64748b" }}>
                        {operatorLabel}
                      </div>

                      {/* Scheduled time (pre-formatted in Israel TZ by backend) */}
                      <div className="font-mono font-semibold text-white text-sm">
                        {a.scheduled_display}
                      </div>

                      {/* Countdown */}
                      <div className="text-right font-bold text-sm" style={{ color }}>
                        {departed ? "Left" : mins === 0 ? "Now" : `${mins}m`}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Empty state before any search */}
        {!boardLoading && !board && (
          <div className="flex flex-col items-center justify-center h-64 gap-4 px-6 text-center">
            <div className="p-4 rounded-2xl" style={{ background: "#22c55e10", border: "1px solid #22c55e22" }}>
              <Bus size={32} style={{ color: "#22c55e40" }} />
            </div>
            <div>
              <div className="font-semibold text-sm" style={{ color: "#64748b" }}>
                Search for a stop above
              </div>
              <div className="text-xs mt-1" style={{ color: "#334155" }}>
                Enter a city name (Hebrew or English) or a stop code
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
