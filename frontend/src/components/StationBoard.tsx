"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Search, X, Bus, Clock, RefreshCw, MapPin,
  ChevronRight, AlertCircle, Loader2, Radio,
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
  line_ref: number | null;
  route_short_name: string | null;
  agency_name: string | null;
  operator: number | null;
  aimed_display: string;
  eta_display: string;
  eta_minutes: number;
  is_realtime: boolean;
  vehicle_ref: string | null;
  stop_code?: number;
  stop_name?: string;
  destination?: string;
  scheduled_display?: string;
  scheduled_time?: string;
}

interface BoardData {
  stop_code: number;
  stop_name: string;
  stop_city: string;
  stop_lat: number | null;
  stop_lon: number | null;
  arrivals: Arrival[];
  server_time_il?: string;
  error?: string;
  service_status?: string;
}

interface TiberiasBoard {
  stops_found: number;
  stops: { code: number; name: string; dist_km: number }[];
  arrivals: Arrival[];
  count: number;
  radius_km: number;
  server_time_il?: string;
  error?: string;
}

const API = "http://localhost:8001/api/buses";
const REFRESH_INTERVAL_MS = 30_000;

export default function StationBoard({
  initialStopCode,
  onClose,
}: {
  initialStopCode: number | null;
  onClose: () => void;
}) {
  const [mode, setMode]             = useState<"single" | "tiberias">("single");
  const [query, setQuery]           = useState("");
  const [cityQuery, setCityQuery]   = useState("");
  const [stops, setStops]           = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [board, setBoard]           = useState<BoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [tibBoard, setTibBoard]     = useState<TiberiasBoard | null>(null);
  const [tibLoading, setTibLoading] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const lineFilterRef               = useRef(lineFilter);
  const [lastRefresh, setLastRefresh]   = useState("");
  const [countdown, setCountdown]       = useState(REFRESH_INTERVAL_MS / 1000);
  const refreshTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep ref in sync for use inside stable callbacks
  useEffect(() => { lineFilterRef.current = lineFilter; }, [lineFilter]);

  // ── Auto-load if a stop code was passed from map click ──────────────────
  useEffect(() => {
    if (!initialStopCode) return;
    loadBoard(initialStopCode);
  }, [initialStopCode]); // eslint-disable-line

  // ── Stop search ──────────────────────────────────────────────────────────
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

  // ── Single-stop board fetch ──────────────────────────────────────────────
  const loadBoard = useCallback(async (stopCode: number) => {
    setBoardLoading(true);
    setBoard(null);
    try {
      const r = await fetch(`${API}/station-board?stop_code=${stopCode}&window_hours=2`);
      const d: BoardData = await r.json();
      setBoard(d);
      setLastRefresh(new Date().toLocaleTimeString("he-IL"));
      setCountdown(REFRESH_INTERVAL_MS / 1000);
    } catch {
      setBoard({
        stop_code: stopCode,
        stop_name: `תחנה ${stopCode}`,
        stop_city: "",
        stop_lat: null,
        stop_lon: null,
        arrivals: [],
        error: "Network error — check that the backend is running on port 8001",
        service_status: "unavailable",
      });
    } finally {
      setBoardLoading(false);
    }
  }, []);

  // ── Tiberias board fetch (reads lineFilter via ref — stable function) ────
  const loadTiberiasBoard = useCallback(async () => {
    setTibLoading(true);
    try {
      const params = new URLSearchParams({ window_hours: "2" });
      if (lineFilterRef.current.trim()) params.append("line", lineFilterRef.current.trim());
      const r = await fetch(`${API}/tiberias-board?${params}`);
      const d: TiberiasBoard = await r.json();
      setTibBoard(d);
      setLastRefresh(new Date().toLocaleTimeString("he-IL"));
      setCountdown(REFRESH_INTERVAL_MS / 1000);
    } catch {
      setTibBoard({
        stops_found: 0, stops: [], arrivals: [], count: 0, radius_km: 1.5,
        error: "Network error — check that the backend is running on port 8001",
      });
    } finally {
      setTibLoading(false);
    }
  }, []); // stable: reads filter via lineFilterRef

  // ── Auto-refresh (single stop) ───────────────────────────────────────────
  useEffect(() => {
    if (mode !== "single" || !selectedStop) return;
    if (refreshTimer.current)  clearInterval(refreshTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    refreshTimer.current   = setInterval(() => loadBoard(selectedStop.code), REFRESH_INTERVAL_MS);
    countdownTimer.current = setInterval(() => {
      setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL_MS / 1000 : c - 1));
    }, 1000);
    return () => {
      if (refreshTimer.current)  clearInterval(refreshTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [selectedStop, mode, loadBoard]);

  // ── Auto-load + auto-refresh (tiberias) ─────────────────────────────────
  useEffect(() => {
    if (mode !== "tiberias") return;
    loadTiberiasBoard();
    if (refreshTimer.current)  clearInterval(refreshTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    refreshTimer.current   = setInterval(loadTiberiasBoard, REFRESH_INTERVAL_MS);
    countdownTimer.current = setInterval(() => {
      setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL_MS / 1000 : c - 1));
    }, 1000);
    return () => {
      if (refreshTimer.current)  clearInterval(refreshTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [mode, loadTiberiasBoard]);

  const handleStopSelect = (stop: Stop) => {
    setSelectedStop(stop);
    setStops([]);
    setQuery("");
    loadBoard(stop.code);
  };

  const etaColor = (mins: number) => {
    if (mins < 0)   return "#475569";
    if (mins === 0) return "#ef4444";
    if (mins <= 5)  return "#f97316";
    if (mins <= 15) return "#eab308";
    return "#22c55e";
  };

  const formatEta = (a: Arrival): string => {
    if (a.eta_display.startsWith("מחר")) return "מחר";
    if (a.eta_minutes > 60) return a.aimed_display || a.scheduled_display || "—";
    return a.eta_display;
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: "#080d18" }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-5 py-4 border-b flex-shrink-0"
        style={{ background: "#0f1623", borderColor: "#253047" }}>
        <div className="p-2 rounded-xl" style={{ background: "#22c55e18", border: "1px solid #22c55e33" }}>
          <Bus size={18} style={{ color: "#22c55e" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-white text-sm">לוח הגעות בזמן אמת</div>
          <div className="text-xs truncate" style={{ color: "#475569" }}>
            {mode === "tiberias"
              ? "כל התחנות ברדיוס 1.5ק״מ סביב טבריה"
              : selectedStop
              ? `${selectedStop.name} · ${selectedStop.city}`
              : "חפש תחנת אוטובוס"}
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg flex-shrink-0"
          style={{ color: "#475569" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}>
          <X size={16} />
        </button>
      </div>

      {/* ── Mode tabs ── */}
      <div className="flex px-4 pt-3 pb-2 gap-2 flex-shrink-0"
        style={{ borderBottom: "1px solid #1e293b" }}>
        <button
          onClick={() => setMode("single")}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
          style={{
            background: mode === "single" ? "#22c55e22" : "transparent",
            color:      mode === "single" ? "#22c55e"   : "#475569",
            border:     `1px solid ${mode === "single" ? "#22c55e44" : "#253047"}`,
          }}
        >
          תחנה בודדת
        </button>
        <button
          onClick={() => setMode("tiberias")}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
          style={{
            background: mode === "tiberias" ? "#22c55e22" : "transparent",
            color:      mode === "tiberias" ? "#22c55e"   : "#475569",
            border:     `1px solid ${mode === "tiberias" ? "#22c55e44" : "#253047"}`,
          }}
        >
          לוח טבריה
        </button>
      </div>

      {/* ── Single-stop search ── */}
      {mode === "single" && (
        <div className="px-4 py-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#475569" }} />
              <input
                value={cityQuery}
                onChange={(e) => setCityQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchStops()}
                placeholder="עיר (e.g. תל אביב)"
                className="w-full pl-8 pr-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "#161f30", border: "1px solid #253047", color: "#e2e8f0" }}
              />
            </div>
            <div className="relative w-28">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchStops()}
                placeholder="קוד תחנה"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "#161f30", border: "1px solid #253047", color: "#e2e8f0" }}
              />
            </div>
            <button
              onClick={searchStops}
              className="px-3 py-2 rounded-lg text-sm font-medium flex-shrink-0"
              style={{ background: "#22c55e22", color: "#22c55e", border: "1px solid #22c55e44" }}
            >
              {stopsLoading ? <Loader2 size={14} className="animate-spin" /> : "חפש"}
            </button>
          </div>

          {stops.length > 0 && (
            <div className="mt-2 rounded-xl overflow-hidden border max-h-48 overflow-y-auto"
              style={{ background: "#0f1623", borderColor: "#253047" }}>
              {stops.map((stop) => (
                <button
                  key={stop.code}
                  onClick={() => handleStopSelect(stop)}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm"
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
              לא נמצאו תחנות — נסה שם עיר אחר
            </div>
          )}
        </div>
      )}

      {/* ── Tiberias line filter ── */}
      {mode === "tiberias" && (
        <div className="px-4 py-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#475569" }} />
              <input
                value={lineFilter}
                onChange={(e) => setLineFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadTiberiasBoard()}
                placeholder="סנן לפי קו (e.g. 6, 430)"
                className="w-full pl-8 pr-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "#161f30", border: "1px solid #253047", color: "#e2e8f0" }}
              />
            </div>
            <button
              onClick={loadTiberiasBoard}
              className="px-3 py-2 rounded-lg text-sm font-medium flex-shrink-0"
              style={{ background: "#22c55e22", color: "#22c55e", border: "1px solid #22c55e44" }}
            >
              {tibLoading ? <Loader2 size={14} className="animate-spin" /> : "סנן"}
            </button>
          </div>
        </div>
      )}

      {/* ── Scrollable content area ── */}
      <div className="flex-1 overflow-y-auto">

        {/* ══ SINGLE STOP MODE ══ */}
        {mode === "single" && (
          <>
            {boardLoading && (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <Loader2 size={28} className="animate-spin" style={{ color: "#22c55e" }} />
                <span className="text-sm" style={{ color: "#475569" }}>טוען נתוני הגעה…</span>
              </div>
            )}

            {!boardLoading && board && (
              <>
                {/* Stop info card */}
                <div className="mx-4 mt-4 p-3 rounded-xl"
                  style={{ background: "#0f1623", border: "1px solid #253047" }}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-sm text-white truncate">{board.stop_name}</div>
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
                      className="p-1.5 rounded-lg ml-2 flex-shrink-0"
                      style={{ color: "#475569", background: "#161f30" }}
                      title="רענן"
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {lastRefresh && (
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-1" style={{ color: "#334155" }}>
                        <Clock size={11} />
                        <span className="text-xs">עודכן {lastRefresh}</span>
                      </div>
                      <div className="text-xs font-mono"
                        style={{ color: countdown <= 10 ? "#f59e0b" : "#334155" }}>
                        רענון בעוד {countdown}ש׳
                      </div>
                    </div>
                  )}
                </div>

                {board.service_status === "unavailable" && (
                  <div className="mx-4 mt-3 p-3 rounded-xl flex items-center gap-2"
                    style={{ background: "#fef3c715", border: "1px solid #f59e0b44", color: "#f59e0b" }}>
                    <AlertCircle size={14} />
                    <span className="text-xs font-semibold">שירות לא זמין כרגע</span>
                  </div>
                )}

                {board.error && board.service_status !== "unavailable" && (
                  <div className="mx-4 mt-3 p-3 rounded-xl flex items-center gap-2"
                    style={{ background: "#ef444415", border: "1px solid #ef444433", color: "#ef4444" }}>
                    <AlertCircle size={14} />
                    <span className="text-xs">{board.error}</span>
                  </div>
                )}

                {board.arrivals.length === 0 && !board.error && (
                  <div className="mx-4 mt-3 p-4 rounded-xl text-center"
                    style={{ background: "#0f1623", border: "1px dashed #253047", color: "#475569" }}>
                    <Bus size={24} className="mx-auto mb-2 opacity-40" />
                    <div className="text-sm">אין יציאות בשעתיים הקרובות</div>
                    <div className="text-xs mt-1" style={{ color: "#334155" }}>
                      No scheduled departures in the next 2 hours
                    </div>
                  </div>
                )}

                {board.arrivals.length > 0 && (
                  <div className="mx-4 mt-3 mb-6 rounded-xl overflow-hidden border"
                    style={{ borderColor: "#253047" }}>
                    <div className="grid px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                      style={{
                        gridTemplateColumns: "2fr 2fr 1fr 1.5fr",
                        background: "#0f1623", color: "#475569",
                        borderBottom: "1px solid #1e293b",
                      }}>
                      <span>קו</span>
                      <span>מפעיל</span>
                      <span>מתוכנן</span>
                      <span className="text-right">ETA</span>
                    </div>

                    {board.arrivals.map((a, i) => {
                      const color     = etaColor(a.eta_minutes);
                      const departed  = a.eta_minutes < -1;
                      const lineLabel = a.route_short_name || (a.line_ref != null ? String(a.line_ref) : "?");
                      const opLabel   = a.agency_name || "—";
                      const dest      = a.destination || "";
                      return (
                        <div
                          key={`${a.vehicle_ref ?? i}-${i}`}
                          className="grid items-center px-3 py-3 text-sm"
                          style={{
                            gridTemplateColumns: "2fr 2fr 1fr 1.5fr",
                            background: i % 2 === 0 ? "#080d18" : "#0a0f1e",
                            borderBottom: "1px solid #0f1623",
                            opacity: departed ? 0.35 : 1,
                          }}
                        >
                          <div className="flex flex-col gap-0.5">
                            <div
                              className="rounded-lg inline-flex items-center justify-center font-bold self-start"
                              style={{
                                minWidth: 32, height: 28, padding: "0 5px",
                                background: "#22c55e22", color: "#22c55e",
                                border: "1px solid #22c55e33",
                                fontSize: lineLabel.length > 3 ? 9 : 12,
                              }}
                            >
                              {lineLabel}
                            </div>
                            {dest && (
                              <div className="truncate" style={{ color: "#475569", fontSize: 9, direction: "rtl" }}>
                                {dest}
                              </div>
                            )}
                          </div>
                          <div className="text-xs truncate" style={{ color: "#64748b" }}>{opLabel}</div>
                          <div className="font-mono text-xs" style={{ color: "#64748b" }}>
                            {a.aimed_display || a.scheduled_display || "—"}
                          </div>
                          <div className="text-right flex items-center justify-end gap-1">
                            {a.is_realtime && (
                              <Radio size={9} style={{ color: "#22c55e", flexShrink: 0 }} aria-label="Real-time" />
                            )}
                            <span className="font-bold text-sm" style={{ color }}>
                              {departed ? "עבר" : formatEta(a)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {board.server_time_il && (
                  <div className="mx-4 mb-4 text-center text-xs" style={{ color: "#1e293b" }}>
                    שרת: {board.server_time_il} (Asia/Jerusalem)
                  </div>
                )}
              </>
            )}

            {!boardLoading && !board && (
              <div className="flex flex-col items-center justify-center h-64 gap-4 px-6 text-center">
                <div className="p-4 rounded-2xl"
                  style={{ background: "#22c55e10", border: "1px solid #22c55e22" }}>
                  <Bus size={32} style={{ color: "#22c55e40" }} />
                </div>
                <div>
                  <div className="font-semibold text-sm" style={{ color: "#64748b" }}>
                    חפש תחנה למעלה
                  </div>
                  <div className="text-xs mt-1" style={{ color: "#334155" }}>
                    הזן שם עיר (עברית או אנגלית) או קוד תחנה
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ══ TIBERIAS BOARD MODE ══ */}
        {mode === "tiberias" && (
          <>
            {tibLoading && (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <Loader2 size={28} className="animate-spin" style={{ color: "#22c55e" }} />
                <span className="text-sm" style={{ color: "#475569" }}>טוען לוח טבריה…</span>
              </div>
            )}

            {!tibLoading && tibBoard && (
              <>
                {/* Stats card */}
                <div className="mx-4 mt-4 p-3 rounded-xl"
                  style={{ background: "#0f1623", border: "1px solid #253047" }}>
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-white">
                        {tibBoard.count} הגעות · {tibBoard.stops_found} תחנות
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: "#475569" }}>
                        ברדיוס {tibBoard.radius_km}ק״מ · מרכז טבריה
                      </div>
                    </div>
                    <button
                      onClick={loadTiberiasBoard}
                      className="p-1.5 rounded-lg ml-2 flex-shrink-0"
                      style={{ color: "#475569", background: "#161f30" }}
                      title="רענן"
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {lastRefresh && (
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-1" style={{ color: "#334155" }}>
                        <Clock size={11} />
                        <span className="text-xs">עודכן {lastRefresh}</span>
                      </div>
                      <div className="text-xs font-mono"
                        style={{ color: countdown <= 10 ? "#f59e0b" : "#334155" }}>
                        רענון בעוד {countdown}ש׳
                      </div>
                    </div>
                  )}
                </div>

                {tibBoard.error && (
                  <div className="mx-4 mt-3 p-3 rounded-xl flex items-center gap-2"
                    style={{ background: "#ef444415", border: "1px solid #ef444433", color: "#ef4444" }}>
                    <AlertCircle size={14} />
                    <span className="text-xs">{tibBoard.error}</span>
                  </div>
                )}

                {tibBoard.arrivals.length === 0 && !tibBoard.error && (
                  <div className="mx-4 mt-3 p-4 rounded-xl text-center"
                    style={{ background: "#0f1623", border: "1px dashed #253047", color: "#475569" }}>
                    <Bus size={24} className="mx-auto mb-2 opacity-40" />
                    <div className="text-sm">אין יציאות בטווח</div>
                    <div className="text-xs mt-1" style={{ color: "#334155" }}>
                      No stops found within {tibBoard.radius_km}km of Tiberias centre
                    </div>
                  </div>
                )}

                {tibBoard.arrivals.length > 0 && (
                  <div className="mx-4 mt-3 mb-6 rounded-xl overflow-hidden border"
                    style={{ borderColor: "#253047" }}>
                    {/* Table header */}
                    <div className="grid px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                      style={{
                        gridTemplateColumns: "1.2fr 1.2fr 2fr 1fr 1.5fr",
                        background: "#0f1623", color: "#475569",
                        borderBottom: "1px solid #1e293b",
                      }}>
                      <span>תחנה</span>
                      <span>קו</span>
                      <span>יעד</span>
                      <span>מתוכנן</span>
                      <span className="text-right">ETA</span>
                    </div>

                    {tibBoard.arrivals.map((a, i) => {
                      const color     = etaColor(a.eta_minutes);
                      const departed  = a.eta_minutes < -1;
                      const lineLabel = a.route_short_name || (a.line_ref != null ? String(a.line_ref) : "?");
                      const dest      = a.destination || a.agency_name || "—";
                      return (
                        <div
                          key={`tib-${a.stop_code}-${a.line_ref}-${i}`}
                          className="grid items-center px-3 py-2.5"
                          style={{
                            gridTemplateColumns: "1.2fr 1.2fr 2fr 1fr 1.5fr",
                            background: i % 2 === 0 ? "#080d18" : "#0a0f1e",
                            borderBottom: "1px solid #0f1623",
                            opacity: departed ? 0.35 : 1,
                          }}
                        >
                          {/* Stop code */}
                          <div className="text-xs font-mono" style={{ color: "#475569" }}>
                            <span style={{ color: "#22c55e50" }}>#</span>
                            {a.stop_code ?? "—"}
                          </div>
                          {/* Line badge */}
                          <div>
                            <div
                              className="inline-flex items-center justify-center font-bold rounded-lg"
                              style={{
                                minWidth: 30, height: 24, padding: "0 5px",
                                background: "#22c55e22", color: "#22c55e",
                                border: "1px solid #22c55e33",
                                fontSize: lineLabel.length > 3 ? 8 : 11,
                              }}
                            >
                              {lineLabel}
                            </div>
                          </div>
                          {/* Destination */}
                          <div className="text-xs truncate" style={{ color: "#cbd5e1", direction: "rtl" }}>{dest}</div>
                          {/* Scheduled */}
                          <div className="font-mono text-xs" style={{ color: "#64748b" }}>
                            {a.aimed_display || a.scheduled_display || "—"}
                          </div>
                          {/* ETA */}
                          <div className="text-right flex items-center justify-end gap-1">
                            {a.is_realtime && (
                              <Radio size={9} style={{ color: "#22c55e" }} aria-label="Live" />
                            )}
                            <span className="font-bold text-xs" style={{ color }}>
                              {departed ? "עבר" : formatEta(a)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {tibBoard.server_time_il && (
                  <div className="mx-4 mb-4 text-center text-xs" style={{ color: "#1e293b" }}>
                    שרת: {tibBoard.server_time_il} (Asia/Jerusalem)
                  </div>
                )}
              </>
            )}

            {!tibLoading && !tibBoard && (
              <div className="flex flex-col items-center justify-center h-64 gap-4 px-6 text-center">
                <div className="p-4 rounded-2xl"
                  style={{ background: "#22c55e10", border: "1px solid #22c55e22" }}>
                  <Bus size={32} style={{ color: "#22c55e40" }} />
                </div>
                <div className="font-semibold text-sm" style={{ color: "#64748b" }}>טוען…</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
