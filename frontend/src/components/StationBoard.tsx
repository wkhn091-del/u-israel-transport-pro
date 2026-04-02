"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { Search, X, RefreshCw, Clock, Loader2, AlertCircle, MapPin, ChevronLeft } from "lucide-react";

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

const PURPLE = "#6B3FA0";
const PURPLE_LIGHT = "#F3EEFF";
const PURPLE_DIM = "#D8C8F5";

function etaMinutes(a: Arrival): number {
  return a.eta_minutes;
}

function etaColor(mins: number): string {
  if (mins < 0) return "#8E8E93";
  if (mins <= 2) return "#FF3B30";
  if (mins <= 8) return "#FF9500";
  return PURPLE;
}

function formatMins(a: Arrival): string {
  const mins = a.eta_minutes;
  if (mins < -1) return "עבר";
  if (mins === 0) return "עכשיו";
  if (mins > 60) return a.aimed_display || a.scheduled_display || "—";
  return String(mins);
}

// ── Arrival row: [time | destination | line-badge] ──────────────────────────
function ArrivalRow({ arrival: a }: { arrival: Arrival }) {
  const mins     = etaMinutes(a);
  const departed = mins < -1;
  const color    = etaColor(mins);
  const lineLabel =
    a.route_short_name || (a.line_ref != null ? String(a.line_ref) : "?");
  const dest = a.destination || "—";
  const minsText = formatMins(a);
  const showDqUnit = !departed && mins > 0 && mins <= 60;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "11px 16px",
        borderBottom: "1px solid #F0F0F5",
        opacity: departed ? 0.45 : 1,
        direction: "rtl",
        background: "#FFFFFF",
      }}
    >
      {/* ── Left: time block ── */}
      <div style={{ width: 62, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
          {a.is_realtime && !departed && (
            <span
              style={{
                width: 7, height: 7, borderRadius: "50%",
                background: "#34C759", display: "inline-block",
                flexShrink: 0, marginBottom: 1,
              }}
            />
          )}
          <span style={{ fontWeight: 800, fontSize: 20, color, lineHeight: 1 }}>
            {minsText}
          </span>
          {showDqUnit && (
            <span style={{ fontWeight: 600, fontSize: 11, color }}>דק&apos;</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 2 }}>
          {a.aimed_display || a.scheduled_display || ""}
        </div>
      </div>

      {/* ── Middle: destination ── */}
      <div
        style={{
          flex: 1,
          padding: "0 12px",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "#1C1C1E",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            direction: "rtl",
          }}
        >
          {dest}
        </div>
      </div>

      {/* ── Right: line badge ── */}
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          background: PURPLE,
          color: "#FFFFFF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 800,
          fontSize: lineLabel.length > 3 ? 9 : lineLabel.length > 2 ? 11 : 15,
          flexShrink: 0,
          boxShadow: `0 2px 8px ${PURPLE}44`,
        }}
      >
        {lineLabel}
      </div>
    </div>
  );
}

// ── Station group header + its rows ─────────────────────────────────────────
function StationGroup({
  stopCode,
  stopName,
  stopCity,
  arrivals,
}: {
  stopCode: number | string;
  stopName: string;
  stopCity?: string;
  arrivals: Arrival[];
}) {
  const heading = stopCity ? `${stopName} / ${stopCity}` : stopName;
  return (
    <div>
      {/* Station header */}
      <div
        style={{
          padding: "8px 16px 6px",
          background: "#F7F7FB",
          borderBottom: "1px solid #EBEBF0",
          borderTop: "1px solid #EBEBF0",
          direction: "rtl",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13, color: "#1C1C1E" }}>
          {heading}
        </div>
        <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 1 }}>
          תחנה מס&apos; {stopCode}
        </div>
      </div>

      {/* Arrival rows */}
      {arrivals.map((a, i) => (
        <ArrivalRow
          key={`${a.vehicle_ref ?? a.line_ref}-${a.stop_code}-${i}`}
          arrival={a}
        />
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function StationBoard({
  initialStopCode,
  onClose,
}: {
  initialStopCode: number | null;
  onClose: () => void;
}) {
  const [mode, setMode]               = useState<"single" | "tiberias">("tiberias");
  const [query, setQuery]             = useState("");
  const [cityQuery, setCityQuery]     = useState("");
  const [stops, setStops]             = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [board, setBoard]             = useState<BoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [tibBoard, setTibBoard]       = useState<TiberiasBoard | null>(null);
  const [tibLoading, setTibLoading]   = useState(false);
  const [lineFilter, setLineFilter]   = useState("");
  const lineFilterRef                 = useRef(lineFilter);
  const [lastRefresh, setLastRefresh] = useState("");
  const [countdown, setCountdown]     = useState(REFRESH_INTERVAL_MS / 1000);
  const refreshTimer                  = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimer                = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { lineFilterRef.current = lineFilter; }, [lineFilter]);

  // Auto-load when a stop code is passed from a map click
  useEffect(() => {
    if (!initialStopCode) return;
    setMode("single");
    loadBoard(initialStopCode);
  }, [initialStopCode]); // eslint-disable-line

  // Stop search
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

  // Single-stop board fetch
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

  // Tiberias board fetch
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
  }, []);

  // Auto-refresh for single stop
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

  // Auto-load + auto-refresh for Tiberias
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

  // Group Tiberias arrivals by stop code
  const groupedStops = tibBoard
    ? tibBoard.arrivals.reduce(
        (acc, a) => {
          const key = a.stop_code ?? 0;
          if (!acc[key]) {
            const meta = tibBoard.stops.find((s) => s.code === key);
            acc[key] = { name: a.stop_name ?? meta?.name ?? `תחנה ${key}`, arrivals: [] };
          }
          acc[key].arrivals.push(a);
          return acc;
        },
        {} as Record<number, { name: string; arrivals: Arrival[] }>
      )
    : {};

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#FFFFFF",
        direction: "rtl",
      }}
    >
      {/* ── Top header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px 12px",
          borderBottom: "1px solid #EBEBF0",
          background: "#FFFFFF",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#1C1C1E" }}>
            לוח הגעות
          </div>
          <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
            {mode === "tiberias"
              ? "תחנות סביב טבריה · 1.5ק״מ"
              : selectedStop
              ? `${selectedStop.name} · ${selectedStop.city}`
              : "חפש תחנת אוטובוס"}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            width: 32, height: 32, borderRadius: 16,
            background: "#F0F0F5", border: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "#3C3C43",
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* ── Mode tabs ── */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid #EBEBF0",
          flexShrink: 0,
        }}
      >
        {(["single", "tiberias"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 12,
              border: "none",
              background: mode === m ? PURPLE : "#F5F5F7",
              color: mode === m ? "#FFFFFF" : "#6E6E73",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            {m === "single" ? "תחנה בודדת" : "לוח טבריה"}
          </button>
        ))}
      </div>

      {/* ── Single-stop search bar ── */}
      {mode === "single" && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #EBEBF0",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <Search
                size={13}
                style={{
                  position: "absolute", right: 10, top: "50%",
                  transform: "translateY(-50%)", color: "#8E8E93",
                  pointerEvents: "none",
                }}
              />
              <input
                value={cityQuery}
                onChange={(e) => setCityQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchStops()}
                placeholder="עיר (e.g. טבריה)"
                style={{
                  width: "100%",
                  padding: "8px 30px 8px 10px",
                  borderRadius: 10,
                  border: "1px solid #DCDCE0",
                  fontSize: 13,
                  color: "#1C1C1E",
                  background: "#F7F7F9",
                  outline: "none",
                  direction: "rtl",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchStops()}
              placeholder="קוד תחנה"
              style={{
                width: 90,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #DCDCE0",
                fontSize: 13,
                color: "#1C1C1E",
                background: "#F7F7F9",
                outline: "none",
                direction: "rtl",
                boxSizing: "border-box",
              }}
            />
            <button
              onClick={searchStops}
              style={{
                padding: "8px 14px",
                borderRadius: 10,
                border: "none",
                background: PURPLE,
                color: "#FFFFFF",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              {stopsLoading ? <Loader2 size={13} className="animate-spin" /> : "חפש"}
            </button>
          </div>

          {stops.length > 0 && (
            <div
              style={{
                marginTop: 8,
                borderRadius: 12,
                border: "1px solid #DCDCE0",
                overflow: "hidden",
                maxHeight: 200,
                overflowY: "auto",
                background: "#FFFFFF",
                boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
              }}
            >
              {stops.map((stop) => (
                <button
                  key={stop.code}
                  onClick={() => handleStopSelect(stop)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "10px 12px",
                    borderBottom: "1px solid #F0F0F5",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "right",
                    direction: "rtl",
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#F7F7F9")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                >
                  <MapPin size={13} style={{ color: PURPLE, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, color: "#1C1C1E", fontWeight: 500 }}>
                    {stop.name}
                  </span>
                  <span style={{ fontSize: 11, color: "#8E8E93" }}>{stop.city}</span>
                  <span style={{ fontSize: 11, color: "#C0C0CC", fontFamily: "monospace" }}>
                    #{stop.code}
                  </span>
                  <ChevronLeft size={12} style={{ color: "#C0C0CC" }} />
                </button>
              ))}
            </div>
          )}
          {stops.length === 0 && !stopsLoading && cityQuery && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#8E8E93", textAlign: "center" }}>
              לא נמצאו תחנות — נסה שם עיר אחר
            </div>
          )}
        </div>
      )}

      {/* ── Tiberias line filter ── */}
      {mode === "tiberias" && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #EBEBF0",
            flexShrink: 0,
            display: "flex",
            gap: 8,
          }}
        >
          <div style={{ flex: 1, position: "relative" }}>
            <Search
              size={13}
              style={{
                position: "absolute", right: 10, top: "50%",
                transform: "translateY(-50%)", color: "#8E8E93",
                pointerEvents: "none",
              }}
            />
            <input
              value={lineFilter}
              onChange={(e) => setLineFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadTiberiasBoard()}
              placeholder="סנן לפי קו (e.g. 6, 430)"
              style={{
                width: "100%",
                padding: "8px 30px 8px 10px",
                borderRadius: 10,
                border: "1px solid #DCDCE0",
                fontSize: 13,
                color: "#1C1C1E",
                background: "#F7F7F9",
                outline: "none",
                direction: "rtl",
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            onClick={loadTiberiasBoard}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              background: PURPLE,
              color: "#FFFFFF",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {tibLoading ? <Loader2 size={13} className="animate-spin" /> : "סנן"}
          </button>
        </div>
      )}

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, overflowY: "auto", background: "#FAFAFA" }}>

        {/* ══ SINGLE STOP MODE ══ */}
        {mode === "single" && (
          <>
            {boardLoading && (
              <div
                style={{
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  height: 200, gap: 12,
                }}
              >
                <Loader2 size={28} className="animate-spin" style={{ color: PURPLE }} />
                <span style={{ fontSize: 13, color: "#8E8E93" }}>טוען נתוני הגעה…</span>
              </div>
            )}

            {!boardLoading && board && (
              <>
                {/* Station header card */}
                <div
                  style={{
                    margin: "12px 14px 0",
                    borderRadius: 14,
                    background: "#FFFFFF",
                    border: "1px solid #EBEBF0",
                    padding: "12px 14px",
                    boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      direction: "rtl",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: "#1C1C1E" }}>
                        {board.stop_name}
                        {board.stop_city ? ` / ${board.stop_city}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                        תחנה מס&apos; {board.stop_code}
                      </div>
                    </div>
                    <button
                      onClick={() => loadBoard(board.stop_code)}
                      style={{
                        width: 30, height: 30, borderRadius: 10,
                        background: PURPLE_LIGHT, border: `1px solid ${PURPLE_DIM}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        cursor: "pointer", flexShrink: 0, marginRight: 8,
                        color: PURPLE,
                      }}
                      title="רענן"
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {lastRefresh && (
                    <div
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        marginTop: 8, direction: "rtl",
                      }}
                    >
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          fontSize: 11, color: "#8E8E93",
                        }}
                      >
                        <Clock size={11} />
                        <span>עודכן {lastRefresh}</span>
                      </div>
                      <div
                        style={{
                          fontSize: 11, fontFamily: "monospace",
                          color: countdown <= 10 ? "#FF9500" : "#C0C0CC",
                        }}
                      >
                        רענון בעוד {countdown}ש׳
                      </div>
                    </div>
                  )}
                </div>

                {board.service_status === "unavailable" && (
                  <div
                    style={{
                      margin: "10px 14px 0",
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "#FFF8EC",
                      border: "1px solid #FFD980",
                      display: "flex", alignItems: "center", gap: 8,
                      color: "#B8861A",
                    }}
                  >
                    <AlertCircle size={14} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>שירות לא זמין כרגע</span>
                  </div>
                )}

                {board.error && board.service_status !== "unavailable" && (
                  <div
                    style={{
                      margin: "10px 14px 0",
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "#FFF0F0",
                      border: "1px solid #FFBCBC",
                      display: "flex", alignItems: "center", gap: 8,
                      color: "#D03030",
                    }}
                  >
                    <AlertCircle size={14} />
                    <span style={{ fontSize: 12 }}>{board.error}</span>
                  </div>
                )}

                {board.arrivals.length === 0 && !board.error && (
                  <div
                    style={{
                      margin: "10px 14px 0",
                      padding: "24px 16px",
                      borderRadius: 14,
                      background: "#FFFFFF",
                      border: "1px dashed #DCDCE0",
                      textAlign: "center", color: "#8E8E93",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      אין יציאות בשעתיים הקרובות
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, color: "#C0C0CC" }}>
                      No scheduled departures in the next 2 hours
                    </div>
                  </div>
                )}

                {board.arrivals.length > 0 && (
                  <div
                    style={{
                      margin: "10px 14px 16px",
                      borderRadius: 14,
                      overflow: "hidden",
                      border: "1px solid #EBEBF0",
                      background: "#FFFFFF",
                      boxShadow: "0 1px 6px rgba(0,0,0,0.04)",
                    }}
                  >
                    {/* Station group header */}
                    <div
                      style={{
                        padding: "8px 16px 6px",
                        background: "#F7F7FB",
                        borderBottom: "1px solid #EBEBF0",
                        direction: "rtl",
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 13, color: "#1C1C1E" }}>
                        {board.stop_name}
                        {board.stop_city ? ` / ${board.stop_city}` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 1 }}>
                        תחנה מס&apos; {board.stop_code}
                      </div>
                    </div>

                    {board.arrivals.map((a, i) => (
                      <ArrivalRow
                        key={`${a.vehicle_ref ?? a.line_ref}-${i}`}
                        arrival={a}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {!boardLoading && !board && (
              <div
                style={{
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  height: 260, gap: 14, padding: "0 24px", textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 64, height: 64, borderRadius: 20,
                    background: PURPLE_LIGHT, border: `1px solid ${PURPLE_DIM}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <MapPin size={28} style={{ color: PURPLE }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#3C3C43" }}>
                    חפש תחנה למעלה
                  </div>
                  <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 4 }}>
                    הזן שם עיר (עברית) או קוד תחנה
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
              <div
                style={{
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  height: 200, gap: 12,
                }}
              >
                <Loader2 size={28} className="animate-spin" style={{ color: PURPLE }} />
                <span style={{ fontSize: 13, color: "#8E8E93" }}>טוען לוח טבריה…</span>
              </div>
            )}

            {!tibLoading && tibBoard && (
              <>
                {/* Stats pill */}
                <div
                  style={{
                    margin: "10px 14px 0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    direction: "rtl",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#8E8E93" }}>
                    {tibBoard.count} הגעות · {tibBoard.stops_found} תחנות
                    {lastRefresh && ` · עודכן ${lastRefresh}`}
                  </div>
                  <button
                    onClick={loadTiberiasBoard}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 10,
                      border: `1px solid ${PURPLE_DIM}`,
                      background: PURPLE_LIGHT,
                      color: PURPLE,
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 5,
                    }}
                  >
                    <RefreshCw size={11} />
                    רענן
                  </button>
                </div>

                {tibBoard.error && (
                  <div
                    style={{
                      margin: "10px 14px 0",
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "#FFF0F0",
                      border: "1px solid #FFBCBC",
                      display: "flex", alignItems: "center", gap: 8,
                      color: "#D03030",
                    }}
                  >
                    <AlertCircle size={14} />
                    <span style={{ fontSize: 12 }}>{tibBoard.error}</span>
                  </div>
                )}

                {tibBoard.arrivals.length === 0 && !tibBoard.error && (
                  <div
                    style={{
                      margin: "10px 14px 0",
                      padding: "24px 16px",
                      borderRadius: 14,
                      background: "#FFFFFF",
                      border: "1px dashed #DCDCE0",
                      textAlign: "center", color: "#8E8E93",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>אין יציאות בטווח</div>
                    <div style={{ fontSize: 11, marginTop: 4, color: "#C0C0CC" }}>
                      No stops found within {tibBoard.radius_km}km of Tiberias centre
                    </div>
                  </div>
                )}

                {tibBoard.arrivals.length > 0 && (
                  <div
                    style={{
                      margin: "10px 14px 16px",
                      borderRadius: 14,
                      overflow: "hidden",
                      border: "1px solid #EBEBF0",
                      background: "#FFFFFF",
                      boxShadow: "0 1px 6px rgba(0,0,0,0.04)",
                    }}
                  >
                    {Object.entries(groupedStops).map(([code, group]) => (
                      <StationGroup
                        key={code}
                        stopCode={Number(code)}
                        stopName={group.name}
                        arrivals={group.arrivals}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {!tibLoading && !tibBoard && (
              <div
                style={{
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  height: 200, gap: 12,
                }}
              >
                <Loader2 size={28} className="animate-spin" style={{ color: PURPLE }} />
                <span style={{ fontSize: 13, color: "#8E8E93" }}>טוען…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
