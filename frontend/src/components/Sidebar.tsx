"use client";
import { Train, Bus, Plane, ChevronLeft, ChevronRight, Activity, Map, MonitorDot, Zap } from "lucide-react";
import type { Layers, ActivePanel } from "./Dashboard";
import type { Vehicle } from "./TransportMap";

interface SidebarProps {
  layers: Layers;
  toggle: (key: keyof Layers) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  activePanel: ActivePanel;
  setActivePanel: (p: ActivePanel) => void;
  vehicles: Vehicle[];
}

const LAYER_ITEMS: {
  key: keyof Layers;
  label: string;
  sublabel: string;
  icon: React.ElementType;
  color: string;
}[] = [
  { key: "trains",  label: "Trains",  sublabel: "Israel Railways",       icon: Train, color: "#3b82f6" },
  { key: "buses",   label: "Buses",   sublabel: "Hasadna Open Bus",      icon: Bus,   color: "#22c55e" },
  { key: "flights", label: "Flights", sublabel: "OpenSky Network",       icon: Plane, color: "#f59e0b" },
];

const NAV_ITEMS: { id: ActivePanel; label: string; icon: React.ElementType; color: string }[] = [
  { id: "map",           label: "Live Map",     icon: Map,        color: "#a78bfa" },
  { id: "station-board", label: "Station Board", icon: MonitorDot, color: "#22c55e" },
];

const TYPE_ICON: Record<string, React.ElementType> = { train: Train, bus: Bus, flight: Plane };
const TYPE_COLOR: Record<string, string> = { train: "#3b82f6", bus: "#22c55e", flight: "#f59e0b" };

const OPERATOR_NAMES: Record<number, string> = {
  3: "Egged", 5: "Dan", 7: "Metropoline", 14: "Nateev",
  15: "Superbus", 16: "Afikim", 18: "Kavim", 25: "Egged T.",
};

function Toggle({ on, color }: { on: boolean; color: string }) {
  return (
    <div
      className="relative flex-shrink-0 w-9 h-5 rounded-full transition-all duration-300"
      style={{ background: on ? color : "#253047" }}
    >
      <div
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-300"
        style={{ left: on ? "calc(100% - 18px)" : "2px" }}
      />
    </div>
  );
}

function VehicleRow({ v }: { v: Vehicle }) {
  const Icon = TYPE_ICON[v.type] ?? Bus;
  const color = TYPE_COLOR[v.type] ?? "#94a3b8";
  const speed = (v.velocity as number | undefined) ?? (v.velocity_ms as number | undefined);
  const speedKmh = speed != null
    ? v.velocity_ms != null
      ? Math.round((speed as number) * 3.6)
      : Math.round(speed as number)
    : null;
  const line = (v.line_ref as number | undefined) ?? (v.train_number as string | undefined);
  const operator = v.operator as number | undefined;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg"
      style={{ background: "#0d1525", border: "1px solid #1e293b" }}
    >
      <div
        className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
        style={{ background: `${color}20`, border: `1px solid ${color}44` }}
      >
        <Icon size={12} style={{ color }} />
      </div>
      <div className="flex-1 min-w-0">
        {line && (
          <div className="text-xs font-bold truncate" style={{ color: "#e2e8f0" }}>
            {v.type === "bus" ? `Line ${line}` : v.type === "train" ? `Train #${line}` : String(line)}
          </div>
        )}
        {v.type === "bus" && operator && (
          <div className="text-xs truncate" style={{ color: "#475569" }}>
            {OPERATOR_NAMES[operator] ?? `Op ${operator}`}
          </div>
        )}
        {v.type === "train" && (v.origin as string | undefined) && (
          <div className="text-xs truncate" style={{ color: "#475569" }}>
            {v.origin as string} → {(v.destination as string | undefined) ?? ""}
          </div>
        )}
        {v.type === "flight" && (v.callsign as string | undefined) && (
          <div className="text-xs font-mono truncate" style={{ color: "#475569" }}>
            {v.callsign as string}
          </div>
        )}
      </div>
      {speedKmh != null && speedKmh > 0 && (
        <div className="text-xs font-mono flex-shrink-0" style={{ color: "#64748b" }}>
          {speedKmh}<span style={{ color: "#334155" }}>km/h</span>
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  layers, toggle, isOpen, setIsOpen,
  activePanel, setActivePanel, vehicles,
}: SidebarProps) {
  // Sort: trains first (few, high-value), then buses by speed descending, then flights
  const sorted = [...vehicles].sort((a, b) => {
    const order = { train: 0, flight: 1, bus: 2 };
    const diff = (order[a.type] ?? 3) - (order[b.type] ?? 3);
    if (diff !== 0) return diff;
    const sa = (a.velocity as number | undefined) ?? 0;
    const sb = (b.velocity as number | undefined) ?? 0;
    return sb - sa;
  });
  const topVehicles = sorted.slice(0, 12);

  const counts: Record<keyof Layers, number> = {
    trains:  vehicles.filter(v => v.type === "train").length,
    buses:   vehicles.filter(v => v.type === "bus").length,
    flights: vehicles.filter(v => v.type === "flight").length,
  };

  return (
    <aside
      className="relative flex flex-col transition-all duration-300 border-r select-none overflow-hidden"
      style={{
        width: isOpen ? "240px" : "60px",
        background: "#0f1623",
        borderColor: "#253047",
        flexShrink: 0,
      }}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-4 border-b" style={{ borderColor: "#253047" }}>
        {isOpen && (
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="p-1.5 rounded-lg" style={{ background: "#a78bfa22" }}>
              <Activity size={16} style={{ color: "#a78bfa" }} />
            </div>
            <div className="overflow-hidden">
              <div className="text-white font-bold text-sm tracking-wider whitespace-nowrap">IL TRANSPORT</div>
              <div className="text-xs" style={{ color: "#64748b" }}>Command Center</div>
            </div>
          </div>
        )}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-1.5 rounded-lg transition-colors ml-auto flex-shrink-0"
          style={{ color: "#64748b" }}
          onMouseEnter={e => (e.currentTarget.style.color = "#e2e8f0")}
          onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}
        >
          {isOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {/* ── Views ── */}
      <div className="flex flex-col gap-1 p-2 mt-2">
        {isOpen && (
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-widest" style={{ color: "#475569" }}>
            Views
          </div>
        )}
        {NAV_ITEMS.map(({ id, label, icon: Icon, color }) => {
          const active = activePanel === id;
          return (
            <button
              key={id}
              onClick={() => setActivePanel(id)}
              className="flex items-center rounded-xl transition-all duration-200 w-full"
              style={{
                padding: isOpen ? "9px 12px" : "9px",
                background: active ? `${color}18` : "transparent",
                border: `1px solid ${active ? color + "44" : "transparent"}`,
                justifyContent: isOpen ? "flex-start" : "center",
              }}
              title={!isOpen ? label : undefined}
            >
              <Icon size={16} style={{ color: active ? color : "#64748b", flexShrink: 0 }} />
              {isOpen && (
                <span className="ml-2.5 text-sm font-medium" style={{ color: active ? "#e2e8f0" : "#94a3b8" }}>
                  {label}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mx-3 my-1 border-t" style={{ borderColor: "#1e293b" }} />

      {/* ── Layer Toggles ── */}
      <div className="flex flex-col gap-1 p-2">
        {isOpen && (
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-widest" style={{ color: "#475569" }}>
            Map Layers
          </div>
        )}
        {LAYER_ITEMS.map(({ key, label, sublabel, icon: Icon, color }) => {
          const active = layers[key];
          return (
            <button
              key={key}
              onClick={() => toggle(key)}
              className="flex items-center rounded-xl transition-all duration-200 w-full text-left"
              style={{
                padding: isOpen ? "9px 12px" : "9px",
                background: active ? `${color}15` : "transparent",
                border: `1px solid ${active ? color + "33" : "transparent"}`,
                justifyContent: isOpen ? "flex-start" : "center",
              }}
              title={!isOpen ? label : undefined}
            >
              <div
                className="flex items-center justify-center rounded-lg flex-shrink-0"
                style={{
                  width: 30, height: 30,
                  background: active ? `${color}22` : "#161f3088",
                  border: `1px solid ${active ? color + "44" : "#253047"}`,
                }}
              >
                <Icon size={14} style={{ color: active ? color : "#64748b" }} />
              </div>
              {isOpen && (
                <>
                  <div className="ml-2.5 flex-1 overflow-hidden">
                    <div className="text-xs font-semibold" style={{ color: active ? "#e2e8f0" : "#94a3b8" }}>
                      {label}
                      {counts[key] > 0 && (
                        <span className="ml-1.5 font-mono text-xs" style={{ color: active ? color : "#334155" }}>
                          ({counts[key]})
                        </span>
                      )}
                    </div>
                    <div className="text-xs truncate" style={{ color: "#334155" }}>{sublabel}</div>
                  </div>
                  <div onClick={e => { e.stopPropagation(); toggle(key); }}>
                    <Toggle on={active} color={color} />
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Active Vehicles ── */}
      {isOpen && (
        <>
          <div className="mx-3 my-1 border-t" style={{ borderColor: "#1e293b" }} />
          <div className="flex flex-col flex-1 overflow-hidden p-2">
            <div className="flex items-center justify-between px-2 py-1">
              <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#475569" }}>
                Active Vehicles
              </div>
              {vehicles.length > 0 && (
                <div className="flex items-center gap-1">
                  <Zap size={10} style={{ color: "#22c55e" }} />
                  <span className="text-xs font-mono" style={{ color: "#22c55e" }}>{vehicles.length}</span>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 mt-1">
              {topVehicles.length === 0 ? (
                <div className="text-xs text-center py-6" style={{ color: "#334155" }}>
                  Waiting for data…
                </div>
              ) : (
                topVehicles.map(v => <VehicleRow key={v.id} v={v} />)
              )}
              {vehicles.length > 12 && (
                <div className="text-xs text-center py-1" style={{ color: "#334155" }}>
                  +{vehicles.length - 12} more in view
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Collapsed: icon-only count badge ── */}
      {!isOpen && vehicles.length > 0 && (
        <div className="flex flex-col items-center mt-3 gap-1">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
            style={{ background: "#22c55e18", border: "1px solid #22c55e33", color: "#22c55e" }}
          >
            {vehicles.length}
          </div>
          <span className="text-xs" style={{ color: "#334155" }}>live</span>
        </div>
      )}
    </aside>
  );
}
