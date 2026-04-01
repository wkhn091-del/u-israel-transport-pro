"use client";
import { X, Navigation, Gauge, AlertCircle, Clock, ArrowRight, Radio } from "lucide-react";
import type { Vehicle } from "./TransportMap";

const COLORS = { train: "#2563eb", bus: "#16a34a", flight: "#d97706" };
const LABELS = { train: "Train", bus: "Bus", flight: "Flight" };

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  on_time:      { color: "#22c55e", label: "On time" },
  slight_delay: { color: "#f59e0b", label: "Slight delay" },
  delayed:      { color: "#ef4444", label: "Delayed" },
};

const OPERATOR_NAMES: Record<number, string> = {
  3: "Egged", 5: "Dan", 7: "Metropoline", 14: "Nateev Express",
  15: "Superbus", 16: "Afikim", 18: "Kavim", 25: "Egged Taavura",
};

function Row({ label, value, mono, valueColor }: {
  label: string;
  value: string;
  mono?: boolean;
  valueColor?: string;
}) {
  return (
    <div className="flex justify-between items-center gap-3">
      <span className="text-xs flex-shrink-0" style={{ color: "#9ca3af" }}>{label}</span>
      <span
        className={`text-xs text-right font-medium ${mono ? "font-mono" : ""}`}
        style={{ color: valueColor ?? "#374151" }}
      >
        {value}
      </span>
    </div>
  );
}

export default function VehiclePopup({
  vehicle,
  onClose,
}: {
  vehicle: Vehicle;
  onClose: () => void;
}) {
  const color = COLORS[vehicle.type];
  const n = (k: string) => vehicle[k] as number | undefined;
  const s = (k: string) => vehicle[k] as string | undefined;

  const delayMin = n("delay_minutes") ?? n("departure_delay_min") ?? 0;
  const status = s("status");
  const statusStyle = status ? STATUS_STYLE[status] : null;

  // Speed — buses report km/h, flights report m/s
  const speedKmh =
    n("velocity") != null
      ? Math.round(n("velocity")!)
      : n("velocity_ms") != null
      ? Math.round(n("velocity_ms")! * 3.6)
      : null;

  const bearing =
    (n("bearing") ?? n("heading")) != null
      ? Math.round(n("bearing") ?? n("heading") ?? 0)
      : null;

  const operator = n("operator");
  const lineRef = n("line_ref");

  return (
    <div
      className="absolute top-16 right-5 z-[1001] rounded-2xl w-72 overflow-hidden"
      style={{ background: "#ffffff", border: `1.5px solid ${color}55`, boxShadow: `0 8px 40px rgba(0,0,0,0.12), 0 0 0 1px ${color}22` }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ background: `${color}15`, borderBottom: `1px solid ${color}22` }}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: color }} />
          <span className="font-bold text-sm" style={{ color }}>
            {LABELS[vehicle.type]}
          </span>

          {/* Line number badge */}
          {lineRef && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-bold"
              style={{ background: `${color}25`, color, border: `1px solid ${color}44` }}
            >
              Line {lineRef}
            </span>
          )}
          {s("train_number") && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-mono"
              style={{ background: `${color}25`, color, border: `1px solid ${color}44` }}
            >
              #{s("train_number")}
            </span>
          )}
          {s("callsign") && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-mono"
              style={{ background: `${color}25`, color, border: `1px solid ${color}44` }}
            >
              {s("callsign")}
            </span>
          )}
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded-lg"
          style={{ color: "#9ca3af" }}
          onMouseEnter={e => (e.currentTarget.style.color = "#1e1b4b")}
          onMouseLeave={e => (e.currentTarget.style.color = "#9ca3af")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2.5">

        {/* ── BUS INFO ── */}
        {vehicle.type === "bus" && (
          <>
            {s("destination_name") && (
              <div className="flex items-center gap-1.5">
                <ArrowRight size={13} style={{ color, flexShrink: 0 }} />
                <span className="text-sm font-bold" style={{ color: "#1e1b4b", direction: "rtl" }}>
                  {s("destination_name")}
                </span>
              </div>
            )}
            {s("route_short_name") && (
              <Row label="קו" value={s("route_short_name")!} valueColor={color} />
            )}
            {operator && (
              <Row label="Operator" value={OPERATOR_NAMES[operator] ?? `Operator ${operator}`} />
            )}
          </>
        )}

        {/* ── TRAIN INFO ── */}
        {vehicle.type === "train" && s("origin") && s("destination") && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: "#1e1b4b" }}>{s("origin")}</span>
              <ArrowRight size={12} style={{ color: "#475569", flexShrink: 0 }} />
              <span className="text-xs font-semibold" style={{ color: "#1e1b4b" }}>{s("destination")}</span>
            </div>
            {(s("origin_he") || s("destination_he")) && (
              <div className="text-xs" style={{ color: "#475569", direction: "rtl", textAlign: "right" }}>
                {s("origin_he")} ← {s("destination_he")}
              </div>
            )}
            {s("departure_time") && (
              <div className="flex items-center gap-1.5">
                <Clock size={12} style={{ color: "#9ca3af" }} />
                <span className="text-xs font-mono" style={{ color: "#6b7280" }}>
                  {s("departure_time")} → {s("arrival_time")}
                </span>
              </div>
            )}
            {s("platform") && <Row label="Platform" value={s("platform")!} valueColor={color} />}
          </>
        )}

        {/* ── FLIGHT INFO ── */}
        {vehicle.type === "flight" && (
          <>
            {s("origin_country") && <Row label="Country" value={s("origin_country")!} />}
            {n("altitude_m") != null && n("altitude_m")! >= 0 && (
              <div className="flex items-center gap-1.5">
                <Navigation size={12} style={{ color: "#9ca3af" }} />
                <span className="text-xs" style={{ color: "#6b7280" }}>
                  {Math.round(n("altitude_m")!).toLocaleString()} m{" "}
                  {vehicle.on_ground ? <span style={{ color: "#f59e0b" }}>(ground)</span> : ""}
                </span>
              </div>
            )}
          </>
        )}

        {/* ── SHARED FIELDS ── */}
        <div className="border-t pt-2 space-y-2" style={{ borderColor: "#f3f4f6" }}>
          {/* Speed */}
          {speedKmh != null && speedKmh >= 0 && (
            <div className="flex items-center gap-1.5">
              <Gauge size={12} style={{ color: "#9ca3af" }} />
              <span className="text-xs font-mono" style={{ color: "#6b7280" }}>
                {speedKmh} km/h
              </span>
              {speedKmh === 0 && (
                <span className="text-xs" style={{ color: "#9ca3af" }}>(stopped)</span>
              )}
            </div>
          )}

          {/* Bearing */}
          {bearing != null && (
            <div className="flex items-center gap-1.5">
              <Radio size={12} style={{ color: "#9ca3af" }} />
              <span className="text-xs font-mono" style={{ color: "#6b7280" }}>
                {bearing}° bearing
              </span>
            </div>
          )}

          {/* Delay / Status */}
          {statusStyle && (
            <div className="flex items-center gap-1.5">
              <AlertCircle size={12} style={{ color: statusStyle.color }} />
              <span className="text-xs font-semibold" style={{ color: statusStyle.color }}>
                {statusStyle.label}
                {delayMin > 0 ? ` · ${delayMin} min` : ""}
              </span>
            </div>
          )}
        </div>

        {/* Coordinates */}
        <div className="text-xs font-mono pt-0.5" style={{ color: "#d1d5db" }}>
          {vehicle.lat.toFixed(5)}, {vehicle.lon.toFixed(5)}
        </div>
      </div>
    </div>
  );
}
