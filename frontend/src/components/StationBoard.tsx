"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { X, RefreshCw, Loader2, AlertCircle, MapPin, Search } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Arrival {
  line_ref: number | null;
  route_short_name: string | null;
  aimed_display: string;
  eta_minutes: number;
  is_realtime: boolean;
  vehicle_ref: string | null;
  destination?: string;
  scheduled_display?: string;
}

interface StopBoard {
  stop_code: number;
  stop_name: string;
  stop_city: string;
  arrivals: Arrival[];
  error?: string;
  service_status?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API        = "http://localhost:8001/api/buses";
const REFRESH_MS = 30_000;
const GREEN      = "#16a34a";
const GRAY       = "#8E8E93";
const BORDER     = "#EBEBF0";
const BG_SECTION = "#F7F7FB";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMins(a: Arrival): string {
  const m = a.eta_minutes;
  if (m < -1)  return "עבר";
  if (m === 0) return "עכשיו";
  if (m > 60)  return a.aimed_display || a.scheduled_display || "—";
  return String(m);
}

function etaColor(m: number): string {
  if (m < 0)  return "#9ca3af";
  if (m <= 2) return "#ef4444";
  if (m <= 8) return "#f97316";
  return "#1C1C1E";
}

// ── ArrivalRow ─────────────────────────────────────────────────────────────────
// Layout (RTL): [Green line badge — right] [Destination — center] [Minutes — left]
// Matches Moovit / BusNearby design

function ArrivalRow({ a }: { a: Arrival }) {
  const m        = a.eta_minutes;
  const departed = m < -1;
  const color    = etaColor(m);
  const line     = a.route_short_name || (a.line_ref != null ? String(a.line_ref) : "?");
  const dest     = a.destination || "—";
  const minsText = fmtMins(a);
  const showUnit = !departed && m > 0 && m <= 60;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      padding: "12px 14px",
      borderBottom: `1px solid ${BORDER}`,
      opacity: departed ? 0.4 : 1,
      direction: "rtl",
      background: "#fff",
    }}>
      {/* RIGHT: green line-number badge */}
      <div style={{
        minWidth: 44, height: 44, borderRadius: 11,
        background: GREEN, color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 800,
        fontSize: line.length > 3 ? 9 : line.length > 2 ? 11 : 16,
        flexShrink: 0,
        boxShadow: `0 2px 8px ${GREEN}55`,
        padding: "0 4px",
      }}>
        {line}
      </div>

      {/* CENTER: destination + scheduled time */}
      <div style={{
        flex: 1, padding: "0 12px", minWidth: 0, overflow: "hidden",
      }}>
        <div style={{
          fontSize: 15, fontWeight: 600, color: "#1C1C1E",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          direction: "rtl",
        }}>
          {dest}
        </div>
        {a.aimed_display && (
          <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>
            {a.aimed_display}
            {a.is_realtime && !departed && (
              <span style={{ color: GREEN, marginRight: 4 }}>· חי</span>
            )}
          </div>
        )}
      </div>

      {/* LEFT: minutes countdown */}
      <div style={{ textAlign: "left", minWidth: 52, flexShrink: 0 }}>
        <div style={{
          display: "flex", alignItems: "baseline",
          gap: 2, justifyContent: "flex-end",
        }}>
          {a.is_realtime && !departed && (
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: GREEN, display: "inline-block", flexShrink: 0,
              marginBottom: 2,
            }} />
          )}
          <span style={{
            fontWeight: 800, fontSize: 24, color, lineHeight: 1,
          }}>
            {minsText}
          </span>
          {showUnit && (
            <span style={{ fontWeight: 600, fontSize: 11, color }}>דק&apos;</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function StationBoard({
  initialStopCode,
  onClose,
}: {
  initialStopCode: number | null;
  onClose: () => void;
}) {
  const [board, setBoard]         = useState<StopBoard | null>(null);
  const [loading, setLoading]     = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [countdown, setCountdown] = useState(REFRESH_MS / 1000);

  // Stop search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCity, setSearchCity]   = useState("");
  const [searchResults, setSearchResults] = useState<{code:number;name:string;city:string}[]>([]);
  const [searching, setSearching]     = useState(false);

  const refreshRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch arrivals for a stop code ──────────────────────────────────────────
  const fetchStop = useCallback(async (code: number) => {
    setLoading(true);
    setBoard(null);
    try {
      const r = await fetch(`${API}/station-board?stop_code=${code}&window_hours=2`);
      const d: StopBoard = await r.json();
      setBoard(d);
      setLastRefresh(new Date().toLocaleTimeString("he-IL"));
      setCountdown(REFRESH_MS / 1000);
    } catch {
      setBoard({
        stop_code: code, stop_name: `תחנה ${code}`, stop_city: "",
        arrivals: [],
        error: "שגיאת רשת — בדוק שהשרת פועל על פורט 8001",
        service_status: "unavailable",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Load when initialStopCode changes (map click) ───────────────────────────
  useEffect(() => {
    if (!initialStopCode) return;
    fetchStop(initialStopCode);
  }, [initialStopCode, fetchStop]);

  // ── Auto-refresh ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!board) return;
    if (refreshRef.current)   clearInterval(refreshRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    refreshRef.current   = setInterval(() => fetchStop(board.stop_code), REFRESH_MS);
    countdownRef.current = setInterval(
      () => setCountdown(c => c <= 1 ? REFRESH_MS / 1000 : c - 1),
      1000,
    );
    return () => {
      if (refreshRef.current)   clearInterval(refreshRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [board?.stop_code]); // eslint-disable-line

  // ── Search stops ────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() && !searchCity.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const p = new URLSearchParams({ limit: "30" });
      if (searchCity.trim()) p.append("city", searchCity.trim());
      if (/^\d+$/.test(searchQuery.trim())) p.append("code", searchQuery.trim());
      const r = await fetch(`${API}/stops?${p}`);
      const d = await r.json();
      setSearchResults(d.stops ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searchCity]);

  const pickStop = (code: number) => {
    setSearchResults([]);
    setSearchQuery("");
    setSearchCity("");
    fetchStop(code);
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", background: "#FFFFFF", direction: "rtl",
    }}>

      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 16px 12px",
        borderBottom: `1px solid ${BORDER}`,
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#1C1C1E" }}>לוח הגעות</div>
          <div style={{ fontSize: 12, color: GRAY, marginTop: 2 }}>
            {board
              ? `${board.stop_name}${board.stop_city ? ` · ${board.stop_city}` : ""}`
              : "לחץ על תחנה במפה"}
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
        ><X size={16} /></button>
      </div>

      {/* ── Search bar ── */}
      <div style={{
        padding: "10px 12px",
        borderBottom: `1px solid ${BORDER}`,
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={searchCity}
            onChange={e => setSearchCity(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
            placeholder="עיר (טבריה…)"
            style={inputStyle}
          />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
            placeholder="קוד תחנה"
            style={{ ...inputStyle, width: 88 }}
          />
          <button onClick={handleSearch} style={searchBtnStyle}>
            {searching
              ? <Loader2 size={13} className="animate-spin" />
              : <Search size={13} />}
          </button>
        </div>

        {searchResults.length > 0 && (
          <div style={{
            marginTop: 8, borderRadius: 12, border: `1px solid ${BORDER}`,
            overflow: "hidden", maxHeight: 200, overflowY: "auto",
            background: "#fff", boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
          }}>
            {searchResults.map(s => (
              <button
                key={s.code}
                onClick={() => pickStop(s.code)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "10px 12px",
                  borderBottom: `1px solid #F0F0F5`,
                  background: "transparent", border: "none",
                  cursor: "pointer", textAlign: "right", direction: "rtl",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#F7F7F9")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <MapPin size={13} style={{ color: GREEN, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, color: "#1C1C1E", fontWeight: 500 }}>
                  {s.name}
                </span>
                <span style={{ fontSize: 11, color: GRAY }}>{s.city}</span>
                <span style={{ fontSize: 11, color: "#C0C0CC", fontFamily: "monospace" }}>
                  #{s.code}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Refresh bar ── */}
      {board && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 14px",
          borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
          background: BG_SECTION,
        }}>
          <div style={{ fontSize: 11, color: GRAY }}>
            {lastRefresh ? `עודכן ${lastRefresh}` : "טוען…"}
            {" · "}
            <span style={{ color: countdown <= 10 ? "#f97316" : "#C0C0CC" }}>
              רענון בעוד {countdown}ש׳
            </span>
          </div>
          <button
            onClick={() => board && fetchStop(board.stop_code)}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 10px", borderRadius: 8,
              border: `1px solid #D8C8F5`, background: "#F3EEFF",
              color: "#6B3FA0", fontWeight: 600, fontSize: 11, cursor: "pointer",
            }}
          >
            <RefreshCw size={10} />
            רענן
          </button>
        </div>
      )}

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, overflowY: "auto", background: "#FAFAFA" }}>

        {/* Loading */}
        {loading && (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            height: 200, gap: 12,
          }}>
            <Loader2 size={28} className="animate-spin" style={{ color: GREEN }} />
            <span style={{ fontSize: 13, color: GRAY }}>טוען נתוני תחנה…</span>
          </div>
        )}

        {/* No stop selected yet */}
        {!loading && !board && (
          <div style={{
            margin: "24px 12px",
            padding: "28px 16px",
            borderRadius: 14,
            background: "#fff",
            border: "1.5px dashed #DCDCE0",
            textAlign: "center",
            color: GRAY,
            direction: "rtl",
          }}>
            <MapPin size={28} style={{ color: "#DCDCE0", marginBottom: 10 }} />
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
              לחץ על תחנה במפה
            </div>
            <div style={{ fontSize: 12 }}>
              כל תחנה מסומנת בעיגול ירוק • לחץ עליה לראות את לוח ההגעות
            </div>
          </div>
        )}

        {/* Station board */}
        {!loading && board && (
          <>
            {/* Stop header */}
            <div style={{
              margin: "12px 12px 0",
              borderRadius: 14, background: "#fff",
              border: `1px solid ${BORDER}`,
              padding: "12px 14px",
              boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
              direction: "rtl",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: "#F0F8F1", border: `1.5px solid ${GREEN}55`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <MapPin size={16} style={{ color: GREEN }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: "#1C1C1E" }}>
                    {board.stop_name}
                  </div>
                  <div style={{ fontSize: 12, color: GRAY, marginTop: 2 }}>
                    תחנה מס&apos; {board.stop_code}
                    {board.stop_city ? ` · ${board.stop_city}` : ""}
                  </div>
                </div>
              </div>
            </div>

            {/* Error banner */}
            {(board.error || board.service_status === "unavailable") && (
              <div style={{
                margin: "10px 12px 0",
                padding: "10px 12px", borderRadius: 12,
                background: board.service_status === "unavailable" ? "#FFF8EC" : "#FFF0F0",
                border: `1px solid ${board.service_status === "unavailable" ? "#FFD980" : "#FFBCBC"}`,
                display: "flex", alignItems: "center", gap: 8,
                color: board.service_status === "unavailable" ? "#B8861A" : "#D03030",
                direction: "rtl",
              }}>
                <AlertCircle size={14} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {board.service_status === "unavailable" ? "שירות לא זמין כרגע" : board.error}
                </span>
              </div>
            )}

            {/* Arrivals list */}
            {board.arrivals.length === 0 && !board.error && (
              <div style={{
                margin: "10px 12px 0",
                padding: "20px 16px", borderRadius: 14,
                background: "#fff", border: "1px dashed #DCDCE0",
                textAlign: "center", color: GRAY, direction: "rtl",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  אין תחנות בקרבה — נסה שוב בקרוב
                </div>
              </div>
            )}

            {board.arrivals.length > 0 && (
              <div style={{
                margin: "10px 12px 16px",
                borderRadius: 14, overflow: "hidden",
                border: `1px solid ${BORDER}`, background: "#fff",
                boxShadow: "0 1px 6px rgba(0,0,0,0.04)",
              }}>
                {/* List header */}
                <div style={{
                  padding: "8px 14px 6px",
                  background: BG_SECTION,
                  borderBottom: `1px solid ${BORDER}`,
                  direction: "rtl",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    קו
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 12, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    יעד
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 12, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    בעוד
                  </div>
                </div>

                {board.arrivals
                  .filter(a => a.eta_minutes >= -1)
                  .slice(0, 10)
                  .map((a, i) => (
                    <ArrivalRow
                      key={`${a.vehicle_ref ?? a.line_ref}-${i}`}
                      a={a}
                    />
                  ))}
              </div>
            )}
          </>
        )}

        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 10px", borderRadius: 10,
  border: `1px solid #DCDCE0`, fontSize: 13, color: "#1C1C1E",
  background: "#F7F7F9", outline: "none", direction: "rtl",
  boxSizing: "border-box",
};

const searchBtnStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 10, border: "none",
  background: GREEN, color: "#fff",
  fontWeight: 700, fontSize: 13, cursor: "pointer",
  flexShrink: 0, display: "flex", alignItems: "center", gap: 4,
};
