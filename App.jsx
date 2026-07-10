import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Plus, X, GripVertical, ChevronUp, ChevronDown, Play, Pause,
  SkipForward, RotateCcw, Music, Search, Check, Volume2, VolumeX,
  Link2, ListMusic, Square, Heart, Bluetooth, BluetoothOff,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const TYPES = {
  AMRAP: { label: "AMRAP", full: "As Many Rounds As Possible", color: "#C6F135", dark: "#3a4406" },
  EMOM: { label: "EMOM", full: "Every Minute On the Minute", color: "#FF5A36", dark: "#4a180a" },
  TIMECAP: { label: "TIME CAP", full: "제한 시간 내 완료", color: "#62B6FF", dark: "#0f2a42" },
  FORTIME: { label: "FOR TIME", full: "최대한 빠르게", color: "#B98CFF", dark: "#2c1f47" },
};

const fmt = (s) => {
  const sign = s < 0 ? "-" : "";
  s = Math.abs(Math.round(s));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${sign}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

const blockDuration = (b) => {
  const work = b.rounds * b.workSeconds;
  const rest = b.restEnabled && b.rounds > 1 ? (b.rounds - 1) * b.restSeconds : 0;
  return work + rest;
};

const uid = () => Math.random().toString(36).slice(2, 9);
const randCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();

// NOTE: window.storage is a Claude-artifact-only API. Outside claude.ai it doesn't
// exist, so this falls back to localStorage (same-device only — friends on other
// devices won't see each other). Swap this out for Firebase/Supabase to make the
// group heart-rate feature work across real devices. See README.md.
const hasClaudeStorage = () => typeof window !== "undefined" && !!window.storage;

async function pushGroupHR(code, name, bpm) {
  try {
    if (hasClaudeStorage()) {
      await window.storage.set(`hrsession:${code}:${name}`, JSON.stringify({ bpm, ts: Date.now() }), true);
    } else {
      const all = JSON.parse(localStorage.getItem("hrsession") || "{}");
      all[`${code}:${name}`] = { bpm, ts: Date.now() };
      localStorage.setItem("hrsession", JSON.stringify(all));
    }
  } catch (e) {}
}

async function fetchGroupRoster(code) {
  try {
    if (hasClaudeStorage()) {
      const res = await window.storage.list(`hrsession:${code}:`, true);
      if (!res || !res.keys) return [];
      const entries = await Promise.all(
        res.keys.map(async (k) => {
          try {
            const r = await window.storage.get(k, true);
            const name = k.split(":").slice(2).join(":");
            const data = JSON.parse(r.value);
            return { name, ...data };
          } catch {
            return null;
          }
        })
      );
      return entries.filter(Boolean);
    }
    const all = JSON.parse(localStorage.getItem("hrsession") || "{}");
    return Object.entries(all)
      .filter(([key]) => key.startsWith(`${code}:`))
      .map(([key, data]) => ({ name: key.split(":").slice(1).join(":"), ...data }));
  } catch (e) {
    return [];
  }
}

function beep(freq = 880, dur = 0.12, ctxRef) {
  try {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = ctxRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "square";
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur + 0.02);
  } catch (e) {}
}

export default function App() {
  const [blocks, setBlocks] = useState([]);
  const [view, setView] = useState("build"); // build | run
  const [muted, setMuted] = useState(false);
  const soundCtx = useRef(null);
  const [prepEnabled, setPrepEnabled] = useState(true);
  const [prepMinutes, setPrepMinutes] = useState(0);
  const [prepSeconds, setPrepSeconds] = useState(10);

  // Long-press (250ms) before a drag starts, so a normal tap/scroll isn't
  // hijacked — this is what makes reordering work with touch on iPhone/iPad.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 6 } })
  );

  const [hrSupported] = useState(typeof navigator !== "undefined" && !!navigator.bluetooth);
  const [hrConnected, setHrConnected] = useState(false);
  const [hrValue, setHrValue] = useState(null);
  const [hrDeviceName, setHrDeviceName] = useState("");
  const [hrError, setHrError] = useState("");
  const hrDeviceRef = useRef(null);
  const hrCharRef = useRef(null);

  const parseHeartRate = (dataView) => {
    const flags = dataView.getUint8(0);
    const is16bit = flags & 0x1;
    return is16bit ? dataView.getUint16(1, true) : dataView.getUint8(1);
  };

  const handleHRNotification = useCallback((event) => {
    setHrValue(parseHeartRate(event.target.value));
  }, []);

  const connectHeartRate = useCallback(async () => {
    setHrError("");
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: ["heart_rate"] },
          { namePrefix: "Amazfit" },
          { namePrefix: "T-Rex" },
          { namePrefix: "Zepp" },
        ],
        optionalServices: ["heart_rate"],
      });
      hrDeviceRef.current = device;
      device.addEventListener("gattserverdisconnected", () => {
        setHrConnected(false);
        setHrValue(null);
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService("heart_rate");
      const characteristic = await service.getCharacteristic("heart_rate_measurement");
      hrCharRef.current = characteristic;
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", handleHRNotification);
      setHrDeviceName(device.name || "심박 센서");
      setHrConnected(true);
    } catch (e) {
      // Wrong device selected (no heart_rate service) or user cancelled — disconnect
      // cleanly so the next attempt starts fresh instead of leaving a dangling GATT link.
      if (device?.gatt?.connected) device.gatt.disconnect();
      setHrError(
        e?.name === "NotFoundError"
          ? "이 기기에는 심박 서비스가 없어요. 다른 후보를 선택해보세요."
          : e?.message || "연결에 실패했어요."
      );
    }
  }, [handleHRNotification]);

  const disconnectHeartRate = useCallback(() => {
    if (hrCharRef.current) {
      hrCharRef.current.removeEventListener("characteristicvaluechanged", handleHRNotification);
    }
    if (hrDeviceRef.current?.gatt?.connected) {
      hrDeviceRef.current.gatt.disconnect();
    }
    setHrConnected(false);
    setHrValue(null);
  }, [handleHRNotification]);

  const [groupName, setGroupName] = useState("");
  const [groupCode, setGroupCode] = useState(randCode());
  const [groupJoined, setGroupJoined] = useState(false);
  const [roster, setRoster] = useState([]);

  useEffect(() => {
    if (!groupJoined || !groupCode) return;
    let active = true;
    const tick = async () => {
      if (hrConnected && hrValue != null) {
        await pushGroupHR(groupCode, groupName.trim() || "익명", hrValue);
      }
      const list = await fetchGroupRoster(groupCode);
      if (active) setRoster(list.sort((a, b) => a.name.localeCompare(b.name)));
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [groupJoined, groupCode, groupName, hrConnected, hrValue]);

  const [form, setForm] = useState({
    type: "AMRAP", rounds: 1, minutes: 5, seconds: 0,
    direction: "down", restEnabled: false, restMinutes: 0, restSeconds: 30,
    label: "",
  });

  const addBlock = () => {
    const workSeconds = form.minutes * 60 + form.seconds;
    if (workSeconds <= 0 && form.type !== "FORTIME") return;
    const b = {
      id: uid(),
      type: form.type,
      rounds: Math.max(1, Number(form.rounds) || 1),
      workSeconds,
      direction: form.type === "FORTIME" && workSeconds === 0 ? "up" : form.direction,
      restEnabled: form.restEnabled && form.rounds > 1,
      restSeconds: form.restMinutes * 60 + form.restSeconds,
      label: form.label.trim(),
    };
    setBlocks((prev) => [...prev, b]);
    setForm((f) => ({ ...f, label: "" }));
  };

  const removeBlock = (id) => setBlocks((prev) => prev.filter((b) => b.id !== id));
  const moveBlock = (idx, dir) => {
    setBlocks((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const oldIndex = prev.findIndex((b) => b.id === active.id);
      const newIndex = prev.findIndex((b) => b.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const totalDuration = blocks.reduce((sum, b) => sum + blockDuration(b), 0);

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .app {
          font-family: 'Space Grotesk', sans-serif;
          background: #0E0F0D;
          color: #F2F1EA;
          min-height: 100%;
          padding: clamp(14px, 3vw, 24px) clamp(12px, 4vw, 20px) 60px;
        }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 20px; flex-wrap: wrap; gap: 12px;
        }
        .brand { display: flex; align-items: baseline; gap: 10px; }
        .brand h1 {
          font-size: clamp(17px, 4.5vw, 22px); font-weight: 700; letter-spacing: 1px; margin: 0;
        }
        .brand span { color: #9C9A8E; font-size: 12px; }
        .hr-badge {
          display: flex; align-items: center; gap: 5px; background: #171814; border: 1px solid #2A2B25;
          border-radius: 20px; padding: 6px 12px; font-size: 13px;
        }
        .btn {
          font-family: inherit; border: 1px solid #2A2B25; background: #171814;
          color: #F2F1EA; padding: 9px 14px; border-radius: 8px; cursor: pointer;
          font-size: 13px; display: inline-flex; align-items: center; gap: 6px;
          transition: border-color .15s;
        }
        .btn:hover { border-color: #454639; }
        .btn-accent { background: #C6F135; color: #171907; border-color: #C6F135; font-weight: 600; }
        .btn-accent:hover { background: #d4fb4e; }
        .btn-danger:hover { border-color: #FF5A36; color: #FF5A36; }
        .btn-icon { padding: 8px; }
        .btn:disabled { opacity: .4; cursor: not-allowed; }
        .grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 20px; align-items: start; }
        @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
        .card {
          background: #171814; border: 1px solid #2A2B25; border-radius: 14px; padding: clamp(14px, 4vw, 18px);
        }
        .card + .card { margin-top: 16px; }
        .card h2 {
          font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px;
          color: #9C9A8E; margin: 0 0 14px; font-weight: 600;
        }
        .segmented { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 16px; }
        @media (max-width: 420px) { .segmented { grid-template-columns: repeat(2, 1fr); } }
        .seg-btn {
          font-family: inherit; border: 1px solid #2A2B25; background: #0E0F0D; color: #9C9A8E;
          padding: 10px 6px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600;
          letter-spacing: .5px;
        }
        .seg-btn.active { color: #0E0F0D; border-color: transparent; }
        .field { margin-bottom: 14px; }
        .field label {
          display: block; font-size: 12px; color: #9C9A8E; margin-bottom: 6px;
        }
        .row { display: flex; gap: 10px; }
        .row > * { flex: 1; }
        @media (max-width: 360px) {
          .row { flex-wrap: wrap; }
          .row > * { flex: 1 1 100%; }
        }
        input[type="number"], input[type="text"] {
          width: 100%; background: #0E0F0D; border: 1px solid #2A2B25; color: #F2F1EA;
          padding: 9px 10px; border-radius: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 14px;
        }
        input[type="text"] { font-family: 'Space Grotesk', sans-serif; }
        input:focus { outline: none; border-color: #C6F135; }
        .toggle-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .toggle {
          width: 40px; height: 22px; border-radius: 11px; background: #2A2B25; position: relative;
          cursor: pointer; border: none; flex-shrink: 0;
        }
        .toggle.on { background: #C6F135; }
        .toggle .knob {
          width: 16px; height: 16px; border-radius: 50%; background: #F2F1EA; position: absolute;
          top: 3px; left: 3px; transition: transform .15s;
        }
        .toggle.on .knob { transform: translateX(18px); background: #0E0F0D; }
        .dir-toggle { display: flex; gap: 6px; }
        .dir-btn {
          flex: 1; font-family: inherit; border: 1px solid #2A2B25; background: #0E0F0D; color: #9C9A8E;
          padding: 8px; border-radius: 8px; cursor: pointer; font-size: 12px;
        }
        .dir-btn.active { border-color: #C6F135; color: #C6F135; }
        .empty {
          text-align: center; color: #5c5b52; font-size: 13px; padding: 30px 10px;
          border: 1px dashed #2A2B25; border-radius: 10px;
        }
        .timeline {
          display: flex; height: 34px; border-radius: 8px; overflow: hidden; margin-bottom: 8px;
          border: 1px solid #2A2B25;
        }
        .timeline-seg { min-width: 3px; }
        .timeline-meta { display: flex; justify-content: space-between; font-size: 11px; color: #5c5b52; }
        .cart-item {
          display: flex; align-items: center; gap: 10px; background: #0E0F0D; border: 1px solid #2A2B25;
          border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;
        }
        .drag-handle {
          display: flex; align-items: center; cursor: grab; touch-action: none; padding: 4px;
          margin: -4px; flex-shrink: 0;
        }
        .drag-handle:active { cursor: grabbing; }
        .cart-badge {
          font-size: 10px; font-weight: 700; letter-spacing: .5px; padding: 4px 8px; border-radius: 5px;
          flex-shrink: 0;
        }
        .cart-info { flex: 1; min-width: 0; }
        .cart-info .t1 { font-size: 13px; font-weight: 500; }
        .cart-info .t2 { font-size: 11px; color: #9C9A8E; margin-top: 1px; }
        .cart-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
        .icon-btn {
          background: none; border: none; color: #5c5b52; cursor: pointer; padding: 4px;
          display: flex; align-items: center;
        }
        .icon-btn:hover { color: #F2F1EA; }
        .cart-footer {
          display: flex; justify-content: space-between; align-items: center; margin-top: 14px;
          padding-top: 14px; border-top: 1px solid #2A2B25;
        }
        .total-time { font-size: 12px; color: #9C9A8E; }
        .total-time .mono { color: #F2F1EA; font-size: 15px; margin-left: 6px; }
        .sp-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #9C9A8E; margin-bottom: 14px; }
        .sp-dot { width: 7px; height: 7px; border-radius: 50%; background: #5c5b52; }
        .sp-dot.on { background: #1DB954; }
        .sp-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
        .sp-tab {
          flex: 1; font-family: inherit; border: 1px solid #2A2B25; background: #0E0F0D; color: #9C9A8E;
          padding: 7px; border-radius: 8px; cursor: pointer; font-size: 12px;
        }
        .sp-tab.active { color: #1DB954; border-color: #1DB954; }
        .pl-item, .track-item {
          display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px;
          cursor: pointer; font-size: 13px;
        }
        .pl-item:hover, .track-item:hover { background: #0E0F0D; }
        .pl-item.selected { background: #0E0F0D; border: 1px solid #1DB954; }
        .pl-thumb {
          width: 34px; height: 34px; border-radius: 6px; background: #2A2B25; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center; color: #5c5b52;
        }
        .search-box { display: flex; gap: 6px; margin-bottom: 10px; }
        .search-box input { flex: 1; }
        .note {
          font-size: 11px; color: #5c5b52; margin-top: 12px; line-height: 1.5; border-top: 1px solid #2A2B25;
          padding-top: 10px;
        }
        .hr-live {
          display: flex; align-items: center; justify-content: center; gap: clamp(16px, 6vw, 40px); margin: 26px 0 34px;
        }
        .hr-live .num { font-family: 'IBM Plex Mono', monospace; font-size: clamp(28px, 8vw, 40px); font-weight: 600; }
        .hr-live .lbl { font-size: 11px; color: #9C9A8E; margin-top: 2px; }
        @keyframes beat { 0%, 100% { transform: scale(1); } 25% { transform: scale(1.18); } 45% { transform: scale(1); } }
        .hr-icon-live { animation: beat 0.9s ease-in-out infinite; }
        .roster-item {
          display: flex; align-items: center; gap: 8px; padding: 9px 4px; border-bottom: 1px solid #2A2B25;
          font-size: 13px;
        }
        .roster-item:last-child { border-bottom: none; }
        .run-roster {
          width: 100%; max-width: min(440px, 92vw); margin-top: 24px; background: #171814; border: 1px solid #2A2B25;
          border-radius: 12px; padding: 10px 14px;
        }
        /* run view */
        .run { display: flex; flex-direction: column; align-items: center; padding: 20px 0 40px; }
        .run-block-label { font-size: 13px; color: #9C9A8E; margin-bottom: 4px; }
        .run-phase {
          font-size: 15px; font-weight: 700; letter-spacing: 2px; margin-bottom: 18px; padding: 5px 14px;
          border-radius: 20px;
        }
        .run-time {
          font-family: 'IBM Plex Mono', monospace; font-size: clamp(48px, 16vw, 96px); font-weight: 600; line-height: 1;
          margin-bottom: 6px; letter-spacing: -2px;
        }
        .run-round { font-size: 14px; color: #9C9A8E; margin-bottom: 30px; }
        .run-controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-bottom: 30px; }
        .run-controls .btn { padding: 12px clamp(14px, 4vw, 20px); }
        .amrap-counter {
          display: flex; align-items: center; gap: clamp(8px, 4vw, 16px); background: #171814; border: 1px solid #2A2B25;
          border-radius: 14px; padding: 14px clamp(14px, 5vw, 24px); margin-bottom: 20px;
        }
        .amrap-counter .num { font-family: 'IBM Plex Mono', monospace; font-size: clamp(24px, 8vw, 32px); min-width: 50px; text-align: center; }
        .round-dots { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; max-width: min(320px, 90vw); margin-bottom: 10px; }
        .round-dot { width: 9px; height: 9px; border-radius: 50%; background: #2A2B25; }
        .round-dot.done { background: #C6F135; }
        .round-dot.current { background: #F2F1EA; }
        .run-progress-track {
          width: 100%; max-width: min(440px, 92vw); height: 5px; background: #171814; border-radius: 3px; margin-top: 30px; overflow: hidden;
        }
        .run-progress-fill { height: 100%; background: #C6F135; }
        .done-screen { text-align: center; padding: 60px 0; }
        .done-screen h2 { font-size: 28px; margin-bottom: 8px; }
      `}</style>

      <div className="header">
        <div className="brand">
          <h1>HYBRID TIMER</h1>
          <span>WOD builder + Spotify</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="hr-badge">
            <Heart size={14} color={hrConnected ? "#FF5A36" : "#5c5b52"} fill={hrConnected ? "#FF5A36" : "none"} />
            <span className="mono">{hrValue ? `${hrValue}` : "--"}</span>
            <span style={{ fontSize: 10, color: "#5c5b52" }}>bpm</span>
          </div>
          <button className="btn btn-icon" onClick={() => setMuted((m) => !m)} title="사운드">
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          {view === "run" && (
            <button className="btn" onClick={() => setView("build")}>
              <X size={14} /> 빌더로
            </button>
          )}
        </div>
      </div>

      {view === "build" ? (
        <BuildView
          form={form} setForm={setForm} addBlock={addBlock}
          blocks={blocks} removeBlock={removeBlock} moveBlock={moveBlock}
          dndSensors={dndSensors} handleDragEnd={handleDragEnd}
          totalDuration={totalDuration}
          onStart={() => blocks.length && setView("run")}
          prepEnabled={prepEnabled} setPrepEnabled={setPrepEnabled}
          prepMinutes={prepMinutes} setPrepMinutes={setPrepMinutes}
          prepSeconds={prepSeconds} setPrepSeconds={setPrepSeconds}
          hrSupported={hrSupported} hrConnected={hrConnected} hrValue={hrValue}
          hrDeviceName={hrDeviceName} hrError={hrError}
          connectHeartRate={connectHeartRate} disconnectHeartRate={disconnectHeartRate}
          groupName={groupName} setGroupName={setGroupName}
          groupCode={groupCode} setGroupCode={setGroupCode}
          groupJoined={groupJoined} setGroupJoined={setGroupJoined}
          roster={roster}
        />
      ) : (
        <RunView
          blocks={blocks} muted={muted} soundCtx={soundCtx} onExit={() => setView("build")}
          prepDuration={prepEnabled ? prepMinutes * 60 + prepSeconds : 0}
          hrConnected={hrConnected} hrValue={hrValue}
          groupJoined={groupJoined} roster={roster}
        />
      )}
    </div>
  );
}

function SortableCartItem({ block: b, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: b.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : "auto",
  };
  return (
    <div ref={setNodeRef} style={style} className="cart-item">
      <span className="drag-handle" {...attributes} {...listeners}>
        <GripVertical size={15} color="#5c5b52" />
      </span>
      <span className="cart-badge" style={{ background: TYPES[b.type].color, color: TYPES[b.type].dark }}>
        {TYPES[b.type].label}
      </span>
      <div className="cart-info">
        <div className="t1">{b.label || TYPES[b.type].full}</div>
        <div className="t2">
          {b.rounds > 1 ? `${b.rounds}라운드 × ` : ""}{fmt(b.workSeconds)}
          {b.direction === "up" ? " 정카운트" : " 역카운트"}
          {b.restEnabled && b.rounds > 1 ? ` · 휴식 ${fmt(b.restSeconds)}` : ""}
        </div>
      </div>
      <div className="cart-controls">
        <button className="icon-btn" onClick={onMoveUp}><ChevronUp size={15} /></button>
        <button className="icon-btn" onClick={onMoveDown}><ChevronDown size={15} /></button>
        <button className="icon-btn" onClick={onRemove}><X size={15} /></button>
      </div>
    </div>
  );
}

function BuildView({
  form, setForm, addBlock, blocks, removeBlock, moveBlock, dndSensors, handleDragEnd, totalDuration, onStart,
  prepEnabled, setPrepEnabled, prepMinutes, setPrepMinutes, prepSeconds, setPrepSeconds,
  hrSupported, hrConnected, hrValue, hrDeviceName, hrError, connectHeartRate, disconnectHeartRate,
  groupName, setGroupName, groupCode, setGroupCode, groupJoined, setGroupJoined, roster,
}) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="grid">
      <div>
        <div className="card">
          <h2>블록 만들기</h2>
          <div className="segmented">
            {Object.entries(TYPES).map(([key, t]) => (
              <button
                key={key}
                className={`seg-btn ${form.type === key ? "active" : ""}`}
                style={form.type === key ? { background: t.color } : {}}
                onClick={() => set("type", key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="row">
            <div className="field">
              <label>라운드 수</label>
              <input type="number" min={1} value={form.rounds} onChange={(e) => set("rounds", e.target.value)} />
            </div>
            <div className="field">
              <label>{form.type === "EMOM" ? "라운드당 시간" : form.type === "FORTIME" ? "제한 시간 (0=없음)" : "총 시간"}</label>
              <div className="row" style={{ gap: 6 }}>
                <input type="number" min={0} value={form.minutes} onChange={(e) => set("minutes", Number(e.target.value))} placeholder="분" />
                <input type="number" min={0} max={59} value={form.seconds} onChange={(e) => set("seconds", Number(e.target.value))} placeholder="초" />
              </div>
            </div>
          </div>

          <div className="field">
            <label>카운트 방향</label>
            <div className="dir-toggle">
              <button className={`dir-btn ${form.direction === "down" ? "active" : ""}`} onClick={() => set("direction", "down")}>역카운트 (00:00까지)</button>
              <button className={`dir-btn ${form.direction === "up" ? "active" : ""}`} onClick={() => set("direction", "up")}>정카운트 (계속 증가)</button>
            </div>
          </div>

          <div className="toggle-row">
            <label style={{ fontSize: 13 }}>라운드 사이 휴식</label>
            <button
              className={`toggle ${form.restEnabled ? "on" : ""}`}
              onClick={() => set("restEnabled", !form.restEnabled)}
            >
              <div className="knob" />
            </button>
          </div>
          {form.restEnabled && Number(form.rounds) <= 1 && (
            <div style={{ fontSize: 11, color: "#5c5b52", marginTop: -8, marginBottom: 14 }}>
              라운드 수가 2 이상일 때부터 적용돼요.
            </div>
          )}

          {form.restEnabled && (
            <div className="field">
              <label>휴식 시간</label>
              <div className="row" style={{ gap: 6 }}>
                <input type="number" min={0} value={form.restMinutes} onChange={(e) => set("restMinutes", Number(e.target.value))} placeholder="분" />
                <input type="number" min={0} max={59} value={form.restSeconds} onChange={(e) => set("restSeconds", Number(e.target.value))} placeholder="초" />
              </div>
            </div>
          )}

          <div className="field">
            <label>메모 (선택)</label>
            <input type="text" value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="예: 스쿼트 5RM" />
          </div>

          <button className="btn btn-accent" style={{ width: "100%", justifyContent: "center" }} onClick={addBlock}>
            <Plus size={15} /> 카트에 담기
          </button>
        </div>
      </div>

      <div>
        <div className="card">
          <h2>워크아웃 큐 ({blocks.length})</h2>
          {blocks.length === 0 ? (
            <div className="empty">아직 담긴 블록이 없어요.<br />왼쪽에서 블록을 만들어 담아보세요.</div>
          ) : (
            <>
              <div className="timeline">
                {blocks.map((b) => (
                  <div
                    key={b.id}
                    className="timeline-seg"
                    style={{ flex: blockDuration(b) || 1, background: TYPES[b.type].color }}
                    title={`${TYPES[b.type].label} · ${fmt(blockDuration(b))}`}
                  />
                ))}
              </div>
              <div className="timeline-meta">
                <span>시작</span>
                <span>총 {fmt(totalDuration)}</span>
              </div>

              <div style={{ marginTop: 16 }}>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                    {blocks.map((b, idx) => (
                      <SortableCartItem
                        key={b.id} block={b} idx={idx}
                        onMoveUp={() => moveBlock(idx, -1)}
                        onMoveDown={() => moveBlock(idx, 1)}
                        onRemove={() => removeBlock(b.id)}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>

              <div className="toggle-row" style={{ marginTop: 16 }}>
                <label style={{ fontSize: 13 }}>시작 전 준비 카운트</label>
                <button className={`toggle ${prepEnabled ? "on" : ""}`} onClick={() => setPrepEnabled(!prepEnabled)}>
                  <div className="knob" />
                </button>
              </div>
              {prepEnabled && (
                <div className="field">
                  <label>준비 시간</label>
                  <div className="row" style={{ gap: 6 }}>
                    <input type="number" min={0} value={prepMinutes} onChange={(e) => setPrepMinutes(Number(e.target.value))} placeholder="분" />
                    <input type="number" min={0} max={59} value={prepSeconds} onChange={(e) => setPrepSeconds(Number(e.target.value))} placeholder="초" />
                  </div>
                </div>
              )}

              <div className="cart-footer">
                <div className="total-time">
                  예상 총 시간{" "}
                  <span className="mono">
                    {fmt(totalDuration + (prepEnabled ? prepMinutes * 60 + prepSeconds : 0))}
                  </span>
                </div>
                <button className="btn btn-accent" onClick={onStart}>
                  <Play size={14} /> 시작하기
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <SpotifyPanel />
        </div>

        <div className="card">
          <HeartRatePanel
            supported={hrSupported} connected={hrConnected} value={hrValue}
            deviceName={hrDeviceName} error={hrError}
            onConnect={connectHeartRate} onDisconnect={disconnectHeartRate}
          />
        </div>

        <div className="card">
          <GroupHeartRatePanel
            name={groupName} setName={setGroupName}
            code={groupCode} setCode={setGroupCode}
            joined={groupJoined} setJoined={setGroupJoined}
            roster={roster}
          />
        </div>
      </div>
    </div>
  );
}

function SpotifyPanel() {
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("playlists");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);

  const playlists = [
    { id: 1, name: "WOD 파워 믹스", tracks: 42 },
    { id: 2, name: "테크노 HIIT", tracks: 30 },
    { id: 3, name: "쿨다운 로파이", tracks: 18 },
  ];
  const searchResults = query
    ? [
        { id: "s1", name: `${query} (Radio Edit)`, artist: "Artist A" },
        { id: "s2", name: `${query} Remix`, artist: "Artist B" },
        { id: "s3", name: query, artist: "Artist C" },
      ]
    : [];

  return (
    <>
      <h2>Spotify 연동</h2>
      <div className="sp-status">
        <span className={`sp-dot ${connected ? "on" : ""}`} />
        {connected ? "내 계정에 연결됨" : "연결되지 않음"}
      </div>

      {!connected ? (
        <button className="btn" style={{ width: "100%", justifyContent: "center" }} onClick={() => setConnected(true)}>
          <Link2 size={14} /> Spotify 계정 연결
        </button>
      ) : (
        <>
          <div className="sp-tabs">
            <button className={`sp-tab ${tab === "playlists" ? "active" : ""}`} onClick={() => setTab("playlists")}>
              <ListMusic size={13} style={{ marginRight: 4, verticalAlign: -2 }} /> 내 플레이리스트
            </button>
            <button className={`sp-tab ${tab === "search" ? "active" : ""}`} onClick={() => setTab("search")}>
              <Search size={13} style={{ marginRight: 4, verticalAlign: -2 }} /> 곡 검색
            </button>
          </div>

          {tab === "playlists" ? (
            <div>
              {playlists.map((p) => (
                <div key={p.id} className={`pl-item ${selected === p.id ? "selected" : ""}`} onClick={() => setSelected(p.id)}>
                  <div className="pl-thumb"><Music size={16} /></div>
                  <div style={{ flex: 1 }}>
                    <div>{p.name}</div>
                    <div style={{ fontSize: 11, color: "#9C9A8E" }}>{p.tracks}곡</div>
                  </div>
                  {selected === p.id && <Check size={15} color="#1DB954" />}
                </div>
              ))}
            </div>
          ) : (
            <div>
              <div className="search-box">
                <input type="text" placeholder="곡, 아티스트 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              {searchResults.map((t) => (
                <div key={t.id} className="track-item">
                  <div className="pl-thumb"><Music size={14} /></div>
                  <div style={{ flex: 1 }}>
                    <div>{t.name}</div>
                    <div style={{ fontSize: 11, color: "#9C9A8E" }}>{t.artist}</div>
                  </div>
                  <Plus size={14} color="#9C9A8E" />
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="note">
        실제 재생을 붙이려면 본인 Spotify 개발자 계정에서 앱을 등록하고(Client ID),
        Web Playback SDK와 Web API로 연결해야 합니다. 지금은 흐름을 보여주는 목업이에요.
      </div>
    </>
  );
}

function GroupHeartRatePanel({ name, setName, code, setCode, joined, setJoined, roster }) {
  return (
    <>
      <h2>함께 운동하기</h2>
      {!joined ? (
        <>
          <div className="field">
            <label>내 닉네임</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 민수" />
          </div>
          <div className="field">
            <label>방 코드 (친구와 동일하게 입력)</label>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </div>
          <button
            className="btn btn-accent"
            style={{ width: "100%", justifyContent: "center" }}
            disabled={!name.trim()}
            onClick={() => setJoined(true)}
          >
            방 참가하기
          </button>
        </>
      ) : (
        <>
          <div className="sp-status">
            <span className="sp-dot on" style={{ background: "#FF5A36" }} />
            방 코드 <span className="mono" style={{ color: "#F2F1EA" }}>{code}</span> 참가 중
          </div>
          {roster.length === 0 ? (
            <div className="empty">아직 아무도 없어요. 친구에게 같은 방 코드를 알려주세요.</div>
          ) : (
            <div>
              {roster.map((m) => {
                const stale = Date.now() - m.ts > 8000;
                return (
                  <div key={m.name} className="roster-item">
                    <Heart size={15} color={stale ? "#5c5b52" : "#FF5A36"} fill={stale ? "none" : "#FF5A36"} />
                    <span style={{ flex: 1 }}>{m.name}</span>
                    <span className="mono" style={{ color: stale ? "#5c5b52" : "#F2F1EA" }}>
                      {stale ? "연결 끊김" : `${m.bpm} bpm`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <button className="btn" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={() => setJoined(false)}>
            방 나가기
          </button>
        </>
      )}
      <div className="note">
        방 코드는 이 웹앱 사용자라면 누구나 입력해서 볼 수 있어요. 심박수·닉네임이 다른 사람에게도 공유된다는 점 참고해주세요.
      </div>
    </>
  );
}

function HeartRatePanel({ supported, connected, value, deviceName, error, onConnect, onDisconnect }) {
  return (
    <>
      <h2>심박수 연동</h2>
      <div className="sp-status">
        <span className={`sp-dot ${connected ? "on" : ""}`} style={connected ? { background: "#FF5A36" } : {}} />
        {connected ? `${deviceName} 연결됨 · ${value ?? "--"} bpm` : "연결되지 않음"}
      </div>

      {!supported ? (
        <div className="note" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
          이 브라우저는 Web Bluetooth를 지원하지 않아요. iOS 사파리에서는 Bluefy 같은 블루투스 지원 브라우저나
          Web Bluetooth 확장이 필요합니다.
        </div>
      ) : connected ? (
        <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center" }} onClick={onDisconnect}>
          <BluetoothOff size={14} /> 연결 해제
        </button>
      ) : (
        <>
          <button className="btn" style={{ width: "100%", justifyContent: "center" }} onClick={onConnect}>
            <Bluetooth size={14} /> 심박 센서 연결 (T-Rex 3 등)
          </button>
          {error && (
            <div style={{ fontSize: 11, color: "#FF5A36", marginTop: 8 }}>{error}</div>
          )}
        </>
      )}
      <div className="note">
        Amazfit은 워치 설정에서 Heart Rate Push(심박 브로드캐스트)를 켜야 표준 블루투스 심박계처럼 잡혀요.
      </div>
    </>
  );
}

function RunView({ blocks, muted, soundCtx, onExit, prepDuration = 0, hrConnected, hrValue, groupJoined, roster = [] }) {
  const [blockIndex, setBlockIndex] = useState(0);
  const [round, setRound] = useState(1);
  const [phase, setPhase] = useState(prepDuration > 0 ? "ready" : "work"); // ready | work | rest
  const [remaining, setRemaining] = useState(prepDuration > 0 ? prepDuration : blocks[0]?.workSeconds ?? 0);
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [amrapCount, setAmrapCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const tickRef = useRef(null);

  const block = blocks[blockIndex];
  const isOpenEnded = block && block.direction === "up" && block.workSeconds === 0 && phase === "work";

  useEffect(() => {
    if (finished || !block) return;
    if (isPaused) return;
    tickRef.current = setInterval(() => {
      if (isOpenEnded) {
        setElapsed((e) => e + 1);
        return;
      }
      setRemaining((r) => {
        if (r <= 1) {
          advance();
          return 0;
        }
        if (r <= 4) beep(660, 0.08, soundCtx);
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused, blockIndex, round, phase, finished]);

  const advance = () => {
    if (!muted) beep(phase === "work" ? 440 : phase === "ready" ? 660 : 880, 0.15, soundCtx);
    if (phase === "ready") {
      setPhase("work");
      setRemaining(block.workSeconds);
      return;
    }
    if (phase === "work" && block.restEnabled && block.rounds > 1 && round < block.rounds) {
      setPhase("rest");
      setRemaining(block.restSeconds);
      return;
    }
    if (round < block.rounds) {
      setRound((r) => r + 1);
      setPhase("work");
      setRemaining(block.workSeconds);
      return;
    }
    // move to next block
    const nextIdx = blockIndex + 1;
    if (nextIdx >= blocks.length) {
      setFinished(true);
      return;
    }
    setBlockIndex(nextIdx);
    setRound(1);
    setPhase("work");
    setRemaining(blocks[nextIdx].workSeconds);
    setAmrapCount(0);
  };

  const skip = () => { clearInterval(tickRef.current); advance(); };
  const stop = () => setFinished(true);

  if (finished || !block) {
    return (
      <div className="done-screen">
        <h2>운동 완료 🏁</h2>
        <p style={{ color: "#9C9A8E" }}>총 {blocks.length}개 블록을 마쳤어요.</p>
        <button className="btn btn-accent" style={{ marginTop: 20 }} onClick={onExit}>
          <RotateCcw size={14} /> 빌더로 돌아가기
        </button>
      </div>
    );
  }

  const t = TYPES[block.type];
  const overallTotal = blocks.reduce((s, b) => s + blockDuration(b), 0) || 1;
  const overallDone =
    blocks.slice(0, blockIndex).reduce((s, b) => s + blockDuration(b), 0) +
    (phase === "work" ? (round - 1) * (block.workSeconds + (block.restEnabled ? block.restSeconds : 0)) : (round - 1) * block.workSeconds + round * 0) +
    (block.workSeconds - (isOpenEnded ? 0 : remaining));

  return (
    <div className="run">
      <div className="run-block-label">
        {phase === "ready" ? "곧 시작합니다" : `블록 ${blockIndex + 1} / ${blocks.length} — ${block.label || t.full}`}
      </div>
      <div
        className="run-phase"
        style={{
          background: phase === "work" ? t.color : phase === "ready" ? "#F2F1EA" : "#2A2B25",
          color: phase === "work" ? t.dark : phase === "ready" ? "#0E0F0D" : "#9C9A8E",
        }}
      >
        {phase === "ready" ? "준비" : t.label} {phase === "rest" ? "· 휴식" : ""}
      </div>

      <div className="run-time" style={{ color: phase === "rest" ? "#9C9A8E" : "#F2F1EA" }}>
        {isOpenEnded ? fmt(elapsed) : fmt(remaining)}
      </div>

      {hrConnected && (
        <div className="hr-live">
          <Heart className="hr-icon-live" size={26} color="#FF5A36" fill="#FF5A36" />
          <div style={{ textAlign: "center" }}>
            <div className="num">{hrValue ?? "--"}</div>
            <div className="lbl">bpm</div>
          </div>
        </div>
      )}

      {phase !== "ready" && block.rounds > 1 && (
        <div className="run-round">라운드 {round} / {block.rounds}</div>
      )}

      {phase !== "ready" && block.rounds > 1 && block.rounds <= 30 && (
        <div className="round-dots">
          {Array.from({ length: block.rounds }).map((_, i) => (
            <div key={i} className={`round-dot ${i + 1 < round ? "done" : i + 1 === round ? "current" : ""}`} />
          ))}
        </div>
      )}

      {phase === "work" && block.type === "AMRAP" && (
        <div className="amrap-counter">
          <button className="icon-btn" onClick={() => setAmrapCount((c) => Math.max(0, c - 1))}><ChevronDown size={18} /></button>
          <div>
            <div className="num">{amrapCount}</div>
            <div style={{ fontSize: 10, color: "#9C9A8E", textAlign: "center" }}>완료 라운드</div>
          </div>
          <button className="icon-btn" onClick={() => setAmrapCount((c) => c + 1)}><ChevronUp size={18} /></button>
        </div>
      )}

      <div className="run-controls">
        <button className="btn" onClick={() => setIsPaused((p) => !p)}>
          {isPaused ? <Play size={15} /> : <Pause size={15} />} {isPaused ? "재개" : "일시정지"}
        </button>
        <button className="btn" onClick={skip}><SkipForward size={15} /> 다음</button>
        <button className="btn btn-danger" onClick={stop}><Square size={15} /> 종료</button>
      </div>

      <div className="run-progress-track">
        <div className="run-progress-fill" style={{ width: `${Math.min(100, (overallDone / overallTotal) * 100)}%` }} />
      </div>

      {groupJoined && roster.length > 0 && (
        <div className="run-roster">
          {roster.map((m) => {
            const stale = Date.now() - m.ts > 8000;
            return (
              <div key={m.name} className="roster-item">
                <Heart size={13} color={stale ? "#5c5b52" : "#FF5A36"} fill={stale ? "none" : "#FF5A36"} />
                <span style={{ flex: 1 }}>{m.name}</span>
                <span className="mono" style={{ color: stale ? "#5c5b52" : "#F2F1EA" }}>
                  {stale ? "끊김" : `${m.bpm} bpm`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
