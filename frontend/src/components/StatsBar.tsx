"use client";
import { useEffect, useState } from "react";
import { Train, Bus, Plane, Clock, Wifi, WifiOff } from "lucide-react";
import type { Layers, ActivePanel } from "./Dashboard";

interface Stats { trains: number; buses: number; flights: number; busSource: string }

export default function StatsBar({ layers, activePanel }: { layers: Layers; activePanel: ActivePanel }) {
  const [stats, setStats] = useState<Stats>({ trains: 0, buses: 0, flights: 0, busSource: "" });
  const [lastUpdate, setLastUpdate] = useState("");
  const [apiOnline, setApiOnline] = useState(false);

  useEffect(() => {
    const update = async () => {
      try {
        const [t, b, f] = await Promise.allSettled([
          fetch("http://localhost:8001/api/trains/live").then((r) => r.json()),
          fetch("http://localhost:8001/api/buses/live?limit=50").then((r) => r.json()),
          fetch("http://localhost:8001/api/flights/live").then((r) => r.json()),
        ]);
        setStats({
          trains:    t.status === "fulfilled" ? (t.value.trains?.length ?? 0) : 0,
          buses:     b.status === "fulfilled" ? (b.value.buses?.length  ?? 0) : 0,
          flights:   f.status === "fulfilled" ? (f.value.flights?.length ?? 0) : 0,
          busSource: b.status === "fulfilled" ? (b.value.source ?? "") : "",
        });
        setApiOnline(t.status === "fulfilled" || b.status === "fulfilled");
        setLastUpdate(new Date().toLocaleTimeString("he-IL"));
      } catch {
        setApiOnline(false);
      }
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, []);

  const items = [
    { key: "trains"  as keyof Layers, icon: Train, color: "#3b82f6", count: stats.trains,  label: "trains"  },
    { key: "buses"   as keyof Layers, icon: Bus,   color: "#22c55e", count: stats.buses,   label: "buses"   },
    { key: "flights" as keyof Layers, icon: Plane, color: "#f59e0b", count: stats.flights, label: "flights" },
  ];

  return (
    <div
      className="flex items-center gap-5 px-5 py-2.5 border-b text-sm flex-shrink-0"
      style={{ background: "#0f1623", borderColor: "#253047" }}
    >
      {/* API status dot */}
      <div className="flex items-center gap-1.5">
        {apiOnline
          ? <Wifi size={13} style={{ color: "#22c55e" }} />
          : <WifiOff size={13} style={{ color: "#ef4444" }} />}
        <span className="text-xs" style={{ color: apiOnline ? "#22c55e" : "#ef4444" }}>
          {apiOnline ? "API live" : "API offline"}
        </span>
      </div>

      <div className="w-px h-4" style={{ background: "#253047" }} />

      {items.map(({ key, icon: Icon, color, count, label }) => (
        <div
          key={key}
          className="flex items-center gap-1.5 transition-opacity duration-300"
          style={{ opacity: layers[key] ? 1 : 0.35 }}
        >
          <Icon size={14} style={{ color }} />
          <span className="font-bold" style={{ color }}>{count}</span>
          <span style={{ color: "#475569" }}>{label}</span>
        </div>
      ))}

      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "#22c55e15", color: "#22c55e80", border: "1px solid #22c55e22" }}>
        Hasadna Open Bus Stride
      </span>

      {/* Panel breadcrumb */}
      <div className="ml-auto flex items-center gap-1.5" style={{ color: "#334155" }}>
        <span className="text-xs">
          {activePanel === "map" ? "Live Map" : activePanel === "station-board" ? "Station Board" : "Schedule"}
        </span>
      </div>

      {lastUpdate && (
        <div className="flex items-center gap-1 ml-auto" style={{ color: "#475569" }}>
          <Clock size={12} />
          <span className="text-xs">{lastUpdate}</span>
        </div>
      )}
    </div>
  );
}
