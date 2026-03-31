"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import { Bus, Train, Plane, Navigation2, MapPin, ChevronUp, Zap, X } from "lucide-react";
import type { Vehicle } from "./TransportMap";

interface TripPlan {
  origin: string;
  destination: string;
  distance_km: number;
  duration_min: number;
}

interface Layers {
  trains: boolean;
  buses: boolean;
  flights: boolean;
}

export interface BackendTripLeg {
  type: "bus" | "train" | "taxi" | "flight";
  line?: string;
  from?: string;
  to?: string;
  duration_min?: number;
}

export interface BackendTripOption {
  id: string;
  type: "bus" | "train" | "flight" | "mixed";
  label: string;
  line: string;
  operator: string;
  direct: boolean;
  duration_min: number;
  price_ils?: number;
  next_departure_min: number;
  legs?: BackendTripLeg[];
}

interface BottomSheetProps {
  vehicles: Vehicle[];
  lineFilter: string;
  onLineFilterChange: (v: string) => void;
  onShowRoutePlanner: () => void;
  tripPlan?: TripPlan | null;
  tripOptions?: BackendTripOption[];
  focusMode?: boolean;
  onTripPlanClose?: () => void;
  onLayersChange?: (layers: Layers) => void;
  onVehicleSelect?: (v: Vehicle | null) => void;
  selectedVehicleId?: string | null;
}

const OPERATOR_NAMES: Record<number, string> = {
  3: "אגד", 5: "דן", 7: "מטרופולין", 14: "נתיב אקספרס",
  15: "סופרבוס", 16: "אפיקים", 18: "קווים", 25: "אגד תעבורה",
};

type FilterType = "all" | "buses" | "trains" | "flights";

const FILTERS: { id: FilterType; label: string; icon: React.ElementType; color: string; activeBg: string; }[] = [
  { id: "all",     label: "הכל",       icon: Navigation2, color: "#7c3aed", activeBg: "#7c3aed" },
  { id: "buses",   label: "אוטובוסים", icon: Bus,         color: "#16a34a", activeBg: "#16a34a" },
  { id: "trains",  label: "רכבות",     icon: Train,       color: "#2563eb", activeBg: "#2563eb" },
  { id: "flights", label: "טיסות",     icon: Plane,       color: "#d97706", activeBg: "#d97706" },
];

const FILTER_TO_LAYERS: Record<FilterType, Layers> = {
  "all":     { trains: true,  buses: true,  flights: true  },
  "buses":   { trains: false, buses: true,  flights: false },
  "trains":  { trains: true,  buses: false, flights: false },
  "flights": { trains: false, buses: false, flights: true  },
};

// Hebrew "minutes away" countdown ─────────────────────────────────────────────
function hebrewMins(mins: number): string {
  if (mins <= 0) return "עכשיו";
  if (mins === 1) return "בעוד דקה";
  if (mins <= 10) return `בעוד ${mins} דקות`;
  if (mins <= 60) return `בעוד ${mins} דק׳`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `בעוד ${h} שעות` : `בעוד ${h}:${String(m).padStart(2, "0")} שע׳`;
}

function fmt24(baseMs: number, plusMin: number): string {
  const d = new Date(baseMs + plusMin * 60_000);
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Hebrew speed display ─────────────────────────────────────────────────────────
function speedEta(kmh: number): string {
  if (kmh <= 0) return "בתנועה";
  const min = Math.round(60 / kmh);
  if (min <= 1) return "כ-דקה";
  if (min > 60) return ">שעה";
  return `כ-${min} דק׳`;
}

// ── Trip Plan card ────────────────────────────────────────────────────────────
function TripPlanCard({
  plan, backendOptions, onClose,
}: {
  plan: TripPlan; backendOptions?: BackendTripOption[]; onClose: () => void;
}) {
  const nowMs   = Date.now();
  void nowMs; // used by fmt24 calls below
  // Show backend options (real schedule data) only — no fallback fake options
  const displayOptions  = (backendOptions && backendOptions.length > 0) ? backendOptions : null;
  const distKm  = plan.distance_km || 0;
  const distStr = distKm > 0 ? `${distKm} ק"מ` : "";
  const durStr  = plan.duration_min > 0 ? `${plan.duration_min} דק׳` : "";

  return (
    <div style={{
      background: "linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)",
      border: "1.5px solid #c4b5fd",
      borderRadius: 20, padding: 16, marginBottom: 12,
      boxShadow: "0 4px 20px rgba(124,58,237,0.14)",
    }} dir="rtl">

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#1e1b4b" }}>
              {plan.origin.charAt(0).toUpperCase() + plan.origin.slice(1)}
            </span>
            <span style={{ fontSize: 14, color: "#7c3aed", fontWeight: 800 }}>←</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#1e1b4b" }}>
              {plan.destination.charAt(0).toUpperCase() + plan.destination.slice(1)}
            </span>
          </div>
          {(durStr || distStr) && (
            <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#6b7280", fontWeight: 600 }}>
              {durStr && <span>⏱ {durStr} משוער</span>}
              {distStr && <span>📍 {distStr}</span>}
            </div>
          )}
        </div>
        <button onClick={onClose} style={{
          border: "none", background: "#e9d5ff", color: "#7c3aed",
          width: 24, height: 24, borderRadius: "50%", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <X size={12} />
        </button>
      </div>

      {/* Transport options */}
      <div style={{ fontSize: 10, fontWeight: 800, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
        אפשרויות נסיעה
      </div>

      {/* ── Backend-provided options (real Israel transit data) ── */}
      {displayOptions ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {displayOptions.map((opt) => {
            const effectiveType = opt.type === "mixed" ? "train" : opt.type;
            const bgColor   = effectiveType === "bus" ? "#16a34a" : effectiveType === "train" ? "#2563eb" : "#d97706";
            const chipBg    = effectiveType === "bus" ? "#dcfce7" : effectiveType === "train" ? "#dbeafe" : "#fef3c7";
            const chipColor = effectiveType === "bus" ? "#16a34a" : effectiveType === "train" ? "#2563eb" : "#d97706";
            const badgeText =
              opt.type === "bus" && opt.line.length <= 5 ? opt.line :
              opt.type === "train" ? "🚆" :
              opt.type === "flight" ? "✈️" : "🔀";
            const depTime = fmt24(nowMs, opt.next_departure_min);
            return (
              <div key={opt.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "#ffffff", borderRadius: 13, padding: "10px 12px",
                border: "1px solid #ede9fe",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: 11, flexShrink: 0,
                    background: bgColor, display: "flex", alignItems: "center",
                    justifyContent: "center", color: "#fff",
                    fontSize: opt.type === "bus" && opt.line.length <= 3 ? 14 : 11,
                    fontWeight: 900, boxShadow: `0 2px 8px ${bgColor}55`,
                  }}>
                    {badgeText}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1e1b4b" }}>
                      {opt.label} — {opt.operator}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      יציאה {depTime} · {opt.duration_min} דק׳
                      {!opt.direct && " · עם החלפה"}
                      {opt.direct && " · ישיר"}
                      {opt.price_ils ? ` · ₪${opt.price_ils}` : ""}
                    </div>
                    {/* Show legs for multi-leg trips */}
                    {opt.legs && opt.legs.length > 1 && (
                      <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                        {opt.legs.map((leg, li) => (
                          <span key={li} style={{
                            fontSize: 10, background: "#f0eeff", color: "#7c3aed",
                            borderRadius: 6, padding: "2px 6px", fontWeight: 700,
                          }}>
                            {leg.type === "bus" ? `🚌 ${leg.line ?? ""}` :
                             leg.type === "train" ? "🚆 רכבת" :
                             leg.type === "flight" ? "✈️ טיסה" : "🚕 שירות"}
                            {leg.from ? ` מ${leg.from}` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{
                  background: chipBg, color: chipColor,
                  borderRadius: 9, padding: "5px 10px",
                  fontSize: 11, fontWeight: 800, flexShrink: 0,
                  whiteSpace: "nowrap",
                }}>
                  {hebrewMins(opt.next_departure_min)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── No schedule data — show a clear "not available" message, no fake options ── */
        <div style={{
          padding: "14px 12px", borderRadius: 13,
          background: "#fafafa", border: "1.5px dashed #e2e8f0",
          textAlign: "center",
        }}>
          <div style={{ fontSize: 22, marginBottom: 6 }}>🚌</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>
            אין נתוני לוח זמנים לנתיב זה
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
            Schedule data not available for this route.
            <br />Use the live map to find vehicles near your stop.
          </div>
        </div>
      )}

      {plan.duration_min > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: "#a78bfa", textAlign: "center", fontWeight: 600 }}>
          המסלול מוצג על המפה · לחץ על כלי רכב לפרטים
        </div>
      )}
    </div>
  );
}

// ── Bus line card ─────────────────────────────────────────────────────────────
function BusCard({ lineRef, operator, count, avgSpeed, selected, onClick, onFocus }: {
  lineRef: string; operator?: number; count: number;
  avgSpeed: number; selected: boolean; onClick: () => void;
  onFocus?: () => void;
}) {
  return (
    <button onClick={() => { onClick(); onFocus?.(); }} style={{
      display: "flex", alignItems: "center", gap: 14,
      width: "100%", textAlign: "right",
      background: selected ? "#f0fdf4" : "#ffffff",
      border: `1.5px solid ${selected ? "#16a34a88" : "#f0eeff"}`,
      borderRadius: 18, padding: "13px 14px",
      cursor: "pointer", transition: "all 0.15s",
      boxShadow: selected ? "0 2px 12px rgba(22,163,74,0.12)" : "0 1px 4px rgba(0,0,0,0.04)",
      fontFamily: "inherit",
    }} dir="rtl">
      <div style={{
        flexShrink: 0, width: 50, height: 50, borderRadius: 14,
        background: "#16a34a", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: lineRef.length > 3 ? 12 : 18, fontWeight: 900,
        boxShadow: "0 3px 10px rgba(22,163,74,0.35)", letterSpacing: -0.5,
      }}>
        {lineRef === "?" ? <Bus size={20} /> : lineRef}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#1e1b4b", marginBottom: 2 }}>
          קו {lineRef}
        </div>
        <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>
          {operator ? OPERATOR_NAMES[operator] ?? `מפעיל ${operator}` : "אוטובוס"}
          {" · "}{count} {count === 1 ? "רכב" : "כלי רכב"}
        </div>
      </div>
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          background: "#dcfce7", color: "#16a34a",
          borderRadius: 10, padding: "5px 10px",
          fontSize: 12, fontWeight: 800,
        }}>
          {speedEta(avgSpeed)}
        </div>
        {avgSpeed > 0 && (
          <span style={{ fontSize: 11, color: "#d1d5db", fontFamily: "monospace" }}>
            {avgSpeed} קמ&quot;ש
          </span>
        )}
      </div>
    </button>
  );
}

function TrainCard({ t, selected, onClick }: { t: Vehicle; selected?: boolean; onClick?: () => void }) {
  const speed = (t.velocity as number | undefined) ?? 0;
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 14,
      background: selected ? "#eff6ff" : "#ffffff",
      border: `1.5px solid ${selected ? "#2563eb88" : "#eff6ff"}`,
      borderRadius: 18, padding: "13px 14px",
      boxShadow: selected ? "0 2px 12px rgba(37,99,235,0.12)" : "0 1px 4px rgba(0,0,0,0.04)",
      cursor: onClick ? "pointer" : "default", transition: "all 0.15s",
    }} dir="rtl">
      <div style={{
        flexShrink: 0, width: 50, height: 50, borderRadius: 14,
        background: "#2563eb", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 3px 10px rgba(37,99,235,0.32)",
      }}>
        <Train size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#1e1b4b", marginBottom: 2 }}>
          רכבת #{(t.train_number as string | undefined) ?? t.id}
        </div>
        {(t.destination as string | undefined) && (
          <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>
            ← {t.destination as string}
          </div>
        )}
      </div>
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
        background: "#dbeafe", color: "#2563eb",
        borderRadius: 10, padding: "5px 10px",
        fontSize: 12, fontWeight: 800,
      }}>
        {speedEta(speed)}
      </div>
    </div>
  );
}

function FlightCard({ f, selected, onClick }: { f: Vehicle; selected?: boolean; onClick?: () => void }) {
  const callsign = ((f.callsign as string | undefined) ?? "").trim() || "—";
  const altM = Math.round((f.baro_altitude as number | undefined) ?? 0);
  const speedKmh = Math.round(((f.velocity as number | undefined) ?? 0) * 3.6);
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 14,
      background: selected ? "#fef3c7" : "#ffffff",
      border: `1.5px solid ${selected ? "#d97706aa" : "#fef3c7"}`,
      borderRadius: 18, padding: "13px 14px",
      boxShadow: selected ? "0 2px 12px rgba(217,119,6,0.12)" : "0 1px 4px rgba(0,0,0,0.04)",
      cursor: onClick ? "pointer" : "default", transition: "all 0.15s",
    }} dir="rtl">
      <div style={{
        flexShrink: 0, width: 50, height: 50, borderRadius: 14,
        background: "#d97706", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 3px 10px rgba(217,119,6,0.32)",
      }}>
        <Plane size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#1e1b4b", marginBottom: 2, fontFamily: "monospace" }}>
          {callsign}
        </div>
        {speedKmh > 0 && (
          <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>{speedKmh} קמ&quot;ש</div>
        )}
      </div>
      {altM > 0 && (
        <div style={{
          flexShrink: 0, background: "#fef3c7", color: "#d97706",
          borderRadius: 10, padding: "5px 10px",
          fontSize: 11, fontWeight: 800, fontFamily: "monospace",
        }}>
          {(altM / 1000).toFixed(1)} ק&quot;מ גובה
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon: Icon, label, count, chipBg, chipColor, color }: {
  icon: React.ElementType; label: string; count: number;
  chipBg: string; chipColor: string; color: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      paddingTop: 16, paddingBottom: 10,
    }} dir="rtl">
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <Icon size={14} color={color} />
        <span style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {label}
        </span>
      </div>
      <span style={{ fontSize: 11, fontWeight: 800, color: chipColor, background: chipBg, borderRadius: 999, padding: "2px 10px" }}>
        {count}
      </span>
    </div>
  );
}

// ── Main BottomSheet component ────────────────────────────────────────────────
export default function BottomSheet({
  vehicles, lineFilter, onLineFilterChange, onShowRoutePlanner,
  tripPlan, tripOptions, focusMode, onTripPlanClose, onLayersChange,
  onVehicleSelect, selectedVehicleId,
}: BottomSheetProps) {
  const getInitH = () => typeof window !== "undefined" ? Math.round(window.innerHeight * 0.32) : 270;

  const [height, setHeight] = useState(getInitH);
  const [dragging, setDragging] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY   = useRef(0);
  const startH   = useRef(0);

  // Auto-expand when trip plan arrives
  useEffect(() => {
    if (tripPlan && typeof window !== "undefined")
      setHeight(Math.round(window.innerHeight * 0.64));
  }, [tripPlan]);

  const snap = useCallback((h: number) => {
    if (typeof window === "undefined") return;
    const wh = window.innerHeight;
    const peek = Math.round(wh * 0.09), half = Math.round(wh * 0.40), full = Math.round(wh * 0.84);
    const dP = Math.abs(h - peek), dH = Math.abs(h - half), dF = Math.abs(h - full);
    const mn = Math.min(dP, dH, dF);
    if (mn === dP) setHeight(peek); else if (mn === dH) setHeight(half); else setHeight(full);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    startY.current = e.clientY;
    startH.current = height;
    sheetRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const wh = typeof window !== "undefined" ? window.innerHeight : 800;
    setHeight(Math.max(wh * 0.07, Math.min(wh * 0.92, startH.current + (startY.current - e.clientY))));
  };
  const onPointerUp = () => { setDragging(false); snap(height); };

  const handleFilterChange = (id: FilterType) => {
    setActiveFilter(id);
    onLayersChange?.(FILTER_TO_LAYERS[id]);
  };

  // ── Data buckets ──────────────────────────────────────────────────────────
  const busMap = new Map<string, Vehicle[]>();
  for (const v of vehicles) {
    if (v.type !== "bus") continue;
    // Group by internal line_ref key, but prefer route_short_name for display
    const k = String(v.line_ref ?? "?");
    if (!busMap.has(k)) busMap.set(k, []);
    busMap.get(k)!.push(v);
  }
  const lineGroups = [...busMap.entries()].map(([lineRef, group]) => {
    const speeds = group.map((v) => (v.velocity as number | undefined) ?? 0).filter(Boolean);
    // Use route_short_name (e.g. "430") as the display label when available
    const displayLine = (group[0].route_short_name as string | undefined) || lineRef;
    return {
      lineRef: displayLine,   // BusCard uses this for display
      _key: lineRef,          // internal dedup key (not rendered)
      count: group.length,
      operator: group[0].operator as number | undefined,
      avgSpeed: speeds.length ? Math.round(speeds.reduce((a, b) => a + b) / speeds.length) : 0,
      firstVehicle: group[0],
    };
  }).sort((a, b) => b.count - a.count);

  const trains  = vehicles.filter((v) => v.type === "train");
  const flights = vehicles.filter((v) => v.type === "flight");

  const showBuses   = activeFilter === "all" || activeFilter === "buses";
  const showTrains  = activeFilter === "all" || activeFilter === "trains";
  const showFlights = activeFilter === "all" || activeFilter === "flights";

  const wh = typeof window !== "undefined" ? window.innerHeight : 800;
  const isOpen = height > wh * 0.12;
  const totalCount = vehicles.length;

  return (
    <div
      ref={sheetRef}
      style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        zIndex: 600, height,
        background: "#ffffff",
        borderRadius: "22px 22px 0 0",
        borderTop: "1.5px solid #ede9fe",
        boxShadow: "0 -12px 48px rgba(124,58,237,0.13), 0 -2px 8px rgba(0,0,0,0.05)",
        display: "flex", flexDirection: "column",
        transition: dragging ? "none" : "height 0.30s cubic-bezier(0.32,0.72,0,1)",
        userSelect: "none", willChange: "height",
        fontFamily: "inherit",
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* ── Handle + filters ── */}
      <div style={{ flexShrink: 0, paddingTop: 10, paddingBottom: 6, cursor: "grab" }} onPointerDown={onPointerDown}>
        <div style={{ width: 40, height: 4, borderRadius: 999, background: "#e5e7eb", margin: "0 auto 12px" }} />

        <div
          style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 16, overflowX: "auto", paddingBottom: 2 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {FILTERS.map(({ id, label, icon: Icon, color, activeBg }) => {
            const active = activeFilter === id;
            return (
              <button key={id} onClick={() => handleFilterChange(id)} style={{
                display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                padding: "8px 14px", borderRadius: 999,
                border: `1.5px solid ${active ? activeBg : color + "44"}`,
                background: active ? activeBg : color + "12",
                color: active ? "#ffffff" : color,
                fontSize: 13, fontWeight: 700, cursor: "pointer",
                boxShadow: active ? `0 3px 14px ${activeBg}50` : "none",
                transition: "all 0.15s", fontFamily: "inherit",
              }}>
                <Icon size={13} />
                {label}
              </button>
            );
          })}

          {/* Plan route CTA */}
          <button
            onClick={onShowRoutePlanner}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              marginLeft: "auto", flexShrink: 0,
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 16px", borderRadius: 999, border: "none",
              background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
              color: "#ffffff", fontSize: 13, fontWeight: 800,
              cursor: "pointer", boxShadow: "0 4px 16px rgba(124,58,237,0.40)",
              fontFamily: "inherit",
            }}
          >
            תכנן מסלול ↗
          </button>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      {isOpen ? (
        <div className="bottom-sheet-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 16px 40px" }}>

          {/* Trip Plan card */}
          {tripPlan && (
            <TripPlanCard
              plan={tripPlan}
              backendOptions={tripOptions}
              onClose={() => onTripPlanClose?.()}
            />
          )}

          {/* Buses */}
          {showBuses && lineGroups.length > 0 && (
            <section>
              <SectionHeader
                icon={Bus}
                label={focusMode ? "5 קווים קרובים ביותר" : "קווים בקרבת מקום"}
                color="#16a34a"
                count={Math.min(lineGroups.length, focusMode ? 5 : 10)}
                chipBg="#dcfce7" chipColor="#16a34a"
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {lineGroups.slice(0, focusMode ? 5 : 10).map((g) => (
                  <BusCard key={g._key} {...g}
                    selected={lineFilter === g._key || selectedVehicleId === g.firstVehicle?.id}
                    onClick={() => onLineFilterChange(lineFilter === g._key ? "" : g._key)}
                    onFocus={() => g.firstVehicle && onVehicleSelect?.(g.firstVehicle)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Trains */}
          {showTrains && trains.length > 0 && (
            <section>
              <SectionHeader icon={Train} label="רכבות בקרבת מקום" color="#2563eb"
                count={trains.length} chipBg="#dbeafe" chipColor="#2563eb" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {trains.slice(0, 6).map((t) => (
                  <TrainCard key={t.id} t={t}
                    selected={selectedVehicleId === t.id}
                    onClick={() => onVehicleSelect?.(t)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Flights */}
          {showFlights && flights.length > 0 && (
            <section>
              <SectionHeader icon={Plane} label="טיסות בקרבת מקום" color="#d97706"
                count={flights.length} chipBg="#fef3c7" chipColor="#d97706" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {flights.slice(0, 5).map((f) => (
                  <FlightCard key={f.id} f={f}
                    selected={selectedVehicleId === f.id}
                    onClick={() => onVehicleSelect?.(f)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Empty state */}
          {vehicles.length === 0 && !tripPlan && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 0", gap: 12 }} dir="rtl">
              <MapPin size={36} color="#ddd6fe" />
              <span style={{ fontSize: 14, fontWeight: 700, color: "#9ca3af" }}>אין כלי רכב בתצוגה</span>
              <span style={{ fontSize: 12, color: "#d1d5db" }}>הזז את המפה או כבה מצב מיקוד</span>
            </div>
          )}
        </div>
      ) : (
        /* ── Peek bar ── */
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, paddingBottom: 8, cursor: "pointer" }}
          onPointerDown={onPointerDown}
          onClick={() => setHeight(typeof window !== "undefined" ? Math.round(window.innerHeight * 0.40) : 320)}
          dir="rtl"
        >
          <ChevronUp size={16} color="#7c3aed" />
          <span style={{ fontSize: 14, fontWeight: 700, color: "#7c3aed" }}>
            {tripPlan
              ? `מסלול: ${tripPlan.origin} ← ${tripPlan.destination}`
              : totalCount > 0
              ? `${totalCount} כלי רכב בקרבת מקום`
              : "קווים ותחנות בקרבת מקום"}
          </span>
          {totalCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, background: "#f0eeff", borderRadius: 999, padding: "2px 8px" }}>
              <Zap size={10} color="#7c3aed" />
              <span style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed" }}>עדכני</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
