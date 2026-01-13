import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Play,
  Square,
  Focus,
  Activity,
  Clock,
  Mouse,
  Monitor,
  Shield,
  ShieldAlert,
} from "lucide-react";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";

// --- Types ---
function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

type Area = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type RegionType = "list" | "button";

type Point = {
  x: number;
  y: number;
};

type LogEntry = {
  id: number;
  time: string;
  type: "click" | "scroll" | "info" | "error";
  message: string;
};

type BackendLogPayload = {
  level: "error" | "info" | "warn" | string;
  message: string;
  time?: string;
};

type SystemCheckResult = {
  screen_timeout: number | null;
  screensaver_enabled: boolean;
  screensaver_secured: boolean;
  sleep_timeout: number | null;
  warnings: string[];
};

type RegionConfig = {
  id: string;
  name: string;
  type: RegionType;
  startPoint: Point | null;
  endPoint: Point | null;
};

type PersistedSettingsV1 = {
  clickInterval?: number;
  enableScroll?: boolean;
  scrollInterval?: number;
  scrollAmount?: number;
  keepAwake?: boolean;
  regions?: RegionConfig[];
};

const STORAGE_KEY = "aca_settings_v1";

function makeId() {
  const anyCrypto = (globalThis as any).crypto;
  if (anyCrypto?.randomUUID) return anyCrypto.randomUUID();
  return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createDefaultRegions(): RegionConfig[] {
  const defaults: { name: string; type: RegionType }[] = [
    {
      name: "IP列表",
      type: "list",
    },
    {
      name: "一键更换路线",
      type: "button",
    },
    {
      name: "确定更换路线",
      type: "button",
    },
  ];

  return defaults.map((region, i) => ({
    id: makeId(),
    name: `${region.name}-${i + 1}`,
    type: region.type,
    startPoint: null,
    endPoint: null,
  }));
}

function safeLoadSettings(): PersistedSettingsV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeSaveSettings(settings: PersistedSettingsV1) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

// --- Components ---

const Card = ({
  children,
  className,
  title,
  icon: Icon,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  icon?: any;
}) => (
  <div
    className={cn(
      "bg-white rounded-2xl p-2 shadow-sm border border-slate-100/50 flex flex-col",
      className
    )}
  >
    {title && (
      <div className="flex items-center gap-2 mb-2 text-slate-400 uppercase tracking-widest text-[10px] font-bold">
        {Icon && <Icon className="w-3 h-3" />}
        {title}
      </div>
    )}
    {children}
  </div>
);

// --- Main App ---

function App() {
  // State
  const persisted = safeLoadSettings();

  const [regions, setRegions] = useState<RegionConfig[]>(() => {
    const fromStorage = persisted?.regions;
    if (Array.isArray(fromStorage) && fromStorage.length > 0) {
      // best-effort migrate/validate
      return fromStorage.map((r, idx) => ({
        id: typeof r?.id === "string" ? r.id : makeId(),
        name: typeof r?.name === "string" ? r.name : `区域 ${idx + 1}`,
        type: r?.type === "button" ? "button" : "list",
        startPoint:
          r?.startPoint &&
          typeof r.startPoint.x === "number" &&
          typeof r.startPoint.y === "number"
            ? r.startPoint
            : null,
        endPoint:
          r?.endPoint &&
          typeof r.endPoint.x === "number" &&
          typeof r.endPoint.y === "number"
            ? r.endPoint
            : null,
      }));
    }
    return createDefaultRegions();
  });

  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);

  const [captureStep, setCaptureStep] = useState<
    "none" | "topLeft" | "bottomRight"
  >("none");
  const [captureRegionId, setCaptureRegionId] = useState<string | null>(null);
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);

  const [clickInterval, setClickInterval] = useState(
    typeof persisted?.clickInterval === "number" ? persisted.clickInterval : 30
  );
  const [enableScroll, setEnableScroll] = useState(
    typeof persisted?.enableScroll === "boolean" ? persisted.enableScroll : true
  );
  const [scrollInterval, setScrollInterval] = useState(
    typeof persisted?.scrollInterval === "number" ? persisted.scrollInterval : 5
  );
  const [scrollAmount, setScrollAmount] = useState(
    typeof persisted?.scrollAmount === "number" ? persisted.scrollAmount : 12
  );

  const [isRunning, setIsRunning] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdCounter = useRef(0);
  const [privilegeInfo, setPrivilegeInfo] = useState<string>("检查中...");
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [systemCheck, setSystemCheck] = useState<SystemCheckResult | null>(
    null
  );
  const [keepAwake, setKeepAwake] = useState(
    typeof persisted?.keepAwake === "boolean" ? persisted.keepAwake : true
  );

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Check privileges and system settings on mount
  useEffect(() => {
    invoke<string>("check_privileges")
      .then((info) => {
        setPrivilegeInfo(info);
        const admin = info.includes("管理员权限");
        setIsAdmin(admin);

        // 非管理员时：可选自动提权重启（会弹 UAC；为避免每次启动都弹，做一次性标记）
        if (!admin) {
          const prompted = localStorage.getItem("aca_admin_prompted") === "1";
          if (!prompted) {
            localStorage.setItem("aca_admin_prompted", "1");
            invoke("relaunch_as_admin").catch(() => {
              // 用户拒绝 UAC 或启动失败时，不强制打断；保留红色提示 + 手动按钮
            });
          }
        }
      })
      .catch(() => setPrivilegeInfo("检查失败"));

    invoke<SystemCheckResult>("check_system_settings")
      .then((result) => setSystemCheck(result))
      .catch(() => setSystemCheck(null));

    // Apply keep awake on startup (persisted)
    invoke<string>("set_keep_awake", { enable: keepAwake })
      .then((result) => addLog("info", result))
      .catch((e) => addLog("error", `启用保持活跃失败: ${e}`));
  }, []);

  // Ensure active region is always valid
  useEffect(() => {
    if (regions.length === 0) return;
    if (!activeRegionId || !regions.some((r) => r.id === activeRegionId)) {
      setActiveRegionId(regions[0].id);
    }
  }, [regions, activeRegionId]);

  // Persist settings + regions
  useEffect(() => {
    safeSaveSettings({
      clickInterval,
      enableScroll,
      scrollInterval,
      scrollAmount,
      keepAwake,
      regions,
    });
  }, [
    clickInterval,
    enableScroll,
    scrollInterval,
    scrollAmount,
    keepAwake,
    regions,
  ]);

  // Listeners
  useEffect(() => {
    let unlistenClick: () => void;
    let unlistenScroll: () => void;
    let unlistenStop: () => void;
    let unlistenBackendLog: () => void;

    const setup = async () => {
      unlistenClick = await listen("click-event", (event: any) => {
        const payload = event.payload;
        setClickCount(payload.count);
        addLog("click", `点击于 (${payload.x}, ${payload.y})`, payload.time);
      });

      unlistenScroll = await listen("scroll-event", (event: any) => {
        addLog(
          "scroll",
          `滚动方向 ${event.payload.direction}`,
          event.payload.time
        );
      });

      unlistenStop = await listen("auto-stopped", () => {
        setIsRunning(false);
        addLog("info", "任务已停止");
      });

      unlistenBackendLog = await listen(
        "backend-log",
        (event: { payload: BackendLogPayload }) => {
          const payload = event.payload;
          const mappedType: LogEntry["type"] =
            payload.level === "error" ? "error" : "info";
          addLog(mappedType, `后端: ${payload.message}`, payload.time);
        }
      );
    };
    setup();
    return () => {
      unlistenClick?.();
      unlistenScroll?.();
      unlistenStop?.();
      unlistenBackendLog?.();
    };
  }, []);

  const addLog = (type: LogEntry["type"], message: string, time?: string) => {
    const newLog = {
      id: logIdCounter.current++,
      time: time || new Date().toLocaleTimeString(),
      type,
      message,
    };
    setLogs((prev) => [...prev.slice(-19), newLog]);
  };

  // Capture Logic
  const startCapture = (step: "topLeft" | "bottomRight") => {
    if (!activeRegionId) {
      addLog("error", "请先选择一个区域");
      return;
    }
    setCaptureStep(step);
    setCaptureRegionId(activeRegionId);
    setCaptureCountdown(3);
  };

  useEffect(() => {
    if (captureCountdown === null) return;
    if (captureCountdown > 0) {
      const t = setTimeout(
        () => setCaptureCountdown((p) => (p !== null ? p - 1 : null)),
        1000
      );
      return () => clearTimeout(t);
    }
    if (captureCountdown === 0) {
      invoke("get_mouse_position")
        .then((pos: any) => {
          const [x, y] = pos;
          const targetRegionId = captureRegionId;
          if (!targetRegionId) return;

          if (captureStep === "topLeft") {
            setRegions((prev) =>
              prev.map((r) =>
                r.id === targetRegionId ? { ...r, startPoint: { x, y } } : r
              )
            );
            addLog("info", `左上角设定: ${x},${y}`);
          } else if (captureStep === "bottomRight") {
            setRegions((prev) =>
              prev.map((r) =>
                r.id === targetRegionId ? { ...r, endPoint: { x, y } } : r
              )
            );
            addLog("info", `右下角设定: ${x},${y}`);
          }
        })
        .catch((e: any) => {
          addLog("error", `获取鼠标坐标失败: ${String(e)}`);
        })
        .finally(() => {
          setCaptureStep("none");
          setCaptureRegionId(null);
          setCaptureCountdown(null);
        });
    }
  }, [captureCountdown, captureRegionId, captureStep]);

  const activeRegion = regions.find((r) => r.id === activeRegionId) || null;

  const buildArea = (region: RegionConfig): Area | null => {
    if (!region.startPoint || !region.endPoint) return null;
    return {
      x1: region.startPoint.x,
      y1: region.startPoint.y,
      x2: region.endPoint.x,
      y2: region.endPoint.y,
    };
  };

  const addRegion = () => {
    const nextIndex = regions.length + 1;
    const newRegion: RegionConfig = {
      id: makeId(),
      name: `区域 ${nextIndex}`,
      type: "list",
      startPoint: null,
      endPoint: null,
    };
    setRegions((prev) => [...prev, newRegion]);
    setActiveRegionId(newRegion.id);
  };

  const removeRegion = (id: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== id));
  };

  const moveRegion = (id: string, direction: "up" | "down") => {
    setRegions((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const nextIdx = direction === "up" ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= prev.length) return prev;
      const clone = [...prev];
      const tmp = clone[idx];
      clone[idx] = clone[nextIdx];
      clone[nextIdx] = tmp;
      return clone;
    });
  };

  const updateRegion = (id: string, patch: Partial<RegionConfig>) => {
    setRegions((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  const testClickHere = async () => {
    try {
      const result = await invoke<string>("test_click_here");
      addLog("info", result);
    } catch (e: any) {
      addLog("error", `测试失败: ${String(e)}`);
    }
  };

  const toggleKeepAwake = async () => {
    try {
      const newState = !keepAwake;
      const result = await invoke<string>("set_keep_awake", {
        enable: newState,
      });
      setKeepAwake(newState);
      addLog("info", result);
    } catch (e: any) {
      addLog("error", `切换保持活跃失败: ${String(e)}`);
    }
  };

  const openPowerSettings = async () => {
    try {
      await invoke("open_power_settings");
      addLog("info", "已打开电源设置");
    } catch (e: any) {
      addLog("error", `打开设置失败: ${String(e)}`);
    }
  };

  const relaunchAsAdmin = async () => {
    try {
      await invoke("relaunch_as_admin");
    } catch (e: any) {
      addLog("error", `以管理员重启失败: ${String(e)}`);
    }
  };

  // Task Control
  const toggleTask = async () => {
    if (isRunning) {
      await invoke("stop_clicking");
      setIsRunning(false);
      addLog("info", "用户已停止任务");
    } else {
      if (regions.length === 0) {
        addLog("error", "请先添加至少一个区域");
        return;
      }

      const missing = regions
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => !r.startPoint || !r.endPoint);
      if (missing.length > 0) {
        const names = missing
          .slice(0, 3)
          .map(({ r, idx }) => r.name || `区域 ${idx + 1}`)
          .join("、");
        addLog(
          "error",
          `请先设置以下区域的起点和终点: ${names}${
            missing.length > 3 ? "..." : ""
          }`
        );
        return;
      }

      const invalid = regions
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => {
          if (!r.startPoint || !r.endPoint) return true;
          return (
            r.startPoint.x === r.endPoint.x || r.startPoint.y === r.endPoint.y
          );
        });
      if (invalid.length > 0) {
        const names = invalid
          .slice(0, 3)
          .map(({ r, idx }) => r.name || `区域 ${idx + 1}`)
          .join("、");
        addLog(
          "error",
          `区域无效：起点/终点不能在同一直线 (${names}${
            invalid.length > 3 ? "..." : ""
          })`
        );
        return;
      }
      try {
        await invoke("start_clicking", {
          config: {
            regions: regions.map((r) => ({
              type: r.type,
              area: buildArea(r)!,
            })),
            interval: clickInterval,
            enable_scroll: enableScroll,
            scroll_interval: scrollInterval,
            scroll_amount: scrollAmount,
          },
        });
        setIsRunning(true);
        setClickCount(0);
        addLog("info", "任务已启动");
      } catch (e: any) {
        addLog("error", e.toString());
      }
    }
  };

  return (
    <div className="h-screen w-screen bg-[#F8FAFC] text-slate-800 flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="h-16 px-3 flex items-center justify-between bg-white border-b border-slate-100 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-lg shadow-indigo-200">
            <Mouse className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight text-slate-900 leading-tight">
              自动点击助手
            </h1>
            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
              自动完成重复点击任务
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={testClickHere}
            disabled={isRunning}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50"
          >
            测试点击
          </button>

          {/* Keep Awake Toggle */}
          <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
            <span className="text-xs text-slate-500">保持活跃</span>
            <div
              className={cn(
                "w-10 h-5 rounded-full relative cursor-pointer transition-colors",
                keepAwake ? "bg-green-500" : "bg-slate-300"
              )}
              onClick={toggleKeepAwake}
            >
              <div
                className={cn(
                  "absolute top-1 w-3 h-3 bg-white rounded-full transition-all",
                  keepAwake ? "left-6" : "left-1"
                )}
              />
            </div>
          </div>

          <div
            className={cn(
              "flex items-center gap-1.5 text-xs border-l border-slate-200 pl-3 font-semibold",
              isAdmin ? "text-green-600" : "text-red-500"
            )}
          >
            {isAdmin ? (
              <Shield className="w-4 h-4" />
            ) : (
              <ShieldAlert className="w-4 h-4" />
            )}
            {privilegeInfo}
            {!isAdmin && (
              <button
                onClick={relaunchAsAdmin}
                className="ml-2 px-2 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-600 text-[10px] font-bold"
              >
                以管理员重启
              </button>
            )}
          </div>

          {/* System Check Warning */}
          {systemCheck && systemCheck.warnings.length > 0 && (
            <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
              <div className="relative group">
                <div className="flex items-center gap-1.5 text-xs text-amber-600 cursor-help">
                  <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  <span className="font-semibold">系统设置警告</span>
                </div>
                <div className="absolute top-full right-0 mt-2 w-72 bg-white rounded-lg shadow-xl border border-slate-200 p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                  <div className="space-y-2">
                    {systemCheck.warnings.map((warning, idx) => (
                      <div
                        key={idx}
                        className="text-xs text-amber-700 bg-amber-50 px-2 py-1.5 rounded"
                      >
                        ⚠️ {warning}
                      </div>
                    ))}
                    <button
                      onClick={openPowerSettings}
                      className="w-full text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded mt-2 font-semibold"
                    >
                      打开电源设置
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          className={cn(
            "px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-2 transition-all",
            isRunning
              ? "bg-green-100 text-green-700"
              : "bg-slate-100 text-slate-500"
          )}
        >
          <div
            className={cn(
              "w-2 h-2 rounded-full",
              isRunning ? "bg-green-500 animate-pulse" : "bg-slate-400"
            )}
          />
          {isRunning ? "运行中" : "就绪"}
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 min-h-0 p-3 grid grid-cols-12 auto-rows-min gap-3 overflow-y-auto scrollbar-hide">
        {/* Top Layout: 2/3 + 1/3 (right column split into two cards) */}
        <section className="col-span-12 grid grid-cols-12 gap-3 items-stretch">
          {/* Left: Target Regions (2/3) */}
          <Card className="col-span-9 h-full">
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  区域顺序（每轮按顺序依次点击）
                </div>
                <button
                  onClick={addRegion}
                  disabled={isRunning}
                  className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50"
                >
                  + 新增区域
                </button>
              </div>

              <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                {regions.map((r, idx) => {
                  const active = r.id === activeRegionId;
                  return (
                    <div
                      key={r.id}
                      className={cn(
                        "p-1 rounded-xl border transition-colors",
                        active
                          ? "border-indigo-200 bg-indigo-50/40"
                          : "border-slate-100 bg-white"
                      )}
                    >
                      <div className="flex justify-between items-center col-span-2 not-visited:items-center gap-2">
                        <div className="flex items-center gap-2 col-span-12 not-visited:items-center">
                          <button
                            type="button"
                            disabled={isRunning}
                            onClick={() => setActiveRegionId(r.id)}
                            className={cn(
                              "w-7 h-7 rounded-lg text-xs font-black grid place-items-center shrink-0",
                              active
                                ? "bg-indigo-600 text-white"
                                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            )}
                          >
                            {idx + 1}
                          </button>

                          <input
                            value={r.name}
                            disabled={isRunning}
                            onChange={(e) =>
                              updateRegion(r.id, { name: e.target.value })
                            }
                            className="flex col-span-1 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold outline-none focus:ring-1 focus:ring-indigo-500/20"
                            placeholder={`区域 ${idx + 1}`}
                          />

                          <select
                            value={r.type}
                            disabled={isRunning}
                            onChange={(e) =>
                              updateRegion(r.id, {
                                type: e.target.value as RegionType,
                              })
                            }
                            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-bold text-slate-700"
                          >
                            <option value="list">列表-随机行</option>
                            <option value="button">按钮-中心点</option>
                          </select>

                          <div className="text-[11px] text-slate-500 flex items-center justify-between">
                            <div className="truncate">
                              <span className="font-bold">起点:</span>
                              {r.startPoint
                                ? ` ${r.startPoint.x}, ${r.startPoint.y}`
                                : " 未设置"}
                              <span className="mx-2 opacity-40">|</span>
                              <span className="font-bold">终点:</span>
                              {r.endPoint
                                ? ` ${r.endPoint.x}, ${r.endPoint.y}`
                                : " 未设置"}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={isRunning || idx === 0}
                            onClick={() => moveRegion(r.id, "up")}
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black disabled:opacity-40"
                            title="上移"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={isRunning || idx === regions.length - 1}
                            onClick={() => moveRegion(r.id, "down")}
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black disabled:opacity-40"
                            title="下移"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            disabled={isRunning || regions.length <= 1}
                            onClick={() => removeRegion(r.id)}
                            className="w-7 h-7 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs font-black disabled:opacity-40"
                            title="删除"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-4 gap-3 text-xs">
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2 flex flex-col justify-center items-center">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 text-center whitespace-nowrap">
                    当前区域起点
                  </div>
                  <div className="font-mono text-slate-700 mt-1 font-bold">
                    {activeRegion?.startPoint
                      ? `${activeRegion.startPoint.x}, ${activeRegion.startPoint.y}`
                      : "未设置"}
                  </div>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2 flex flex-col justify-center items-center">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 text-center whitespace-nowrap">
                    当前区域终点
                  </div>
                  <div className="font-mono text-slate-700 mt-1 font-bold">
                    {activeRegion?.endPoint
                      ? `${activeRegion.endPoint.x}, ${activeRegion.endPoint.y}`
                      : "未设置"}
                  </div>
                </div>

                <button
                  disabled={isRunning || !activeRegionId}
                  onClick={() => startCapture("topLeft")}
                  className={cn(
                    "rounded-xl border-2 border-dashed flex flex-col-2 items-center justify-center gap-3 py-1 transition-all hover:bg-slate-50",
                    captureStep === "topLeft"
                      ? "border-indigo-500 bg-indigo-50/50 text-indigo-600 animate-pulse"
                      : "border-slate-200 text-slate-400"
                  )}
                >
                  {captureStep === "topLeft" && captureCountdown !== null ? (
                    <div className="text-xl font-bold">{captureCountdown}</div>
                  ) : (
                    <Focus className="w-4 h-4 opacity-70" />
                  )}
                  <span className="text-[12px] font-bold uppercase">
                    左上角
                  </span>
                </button>
                <button
                  disabled={isRunning || !activeRegionId}
                  onClick={() => startCapture("bottomRight")}
                  className={cn(
                    "rounded-xl border-2 border-dashed flex flex-col-2 items-center justify-center gap-3 py-1 transition-all hover:bg-slate-50",
                    captureStep === "bottomRight"
                      ? "border-indigo-500 bg-indigo-50/50 text-indigo-600 animate-pulse"
                      : "border-slate-200 text-slate-400"
                  )}
                >
                  {captureStep === "bottomRight" &&
                  captureCountdown !== null ? (
                    <div className="text-xl font-bold">{captureCountdown}</div>
                  ) : (
                    <Focus className="w-4 h-4 opacity-70" />
                  )}
                  <span className="text-[12px] font-bold uppercase">
                    右下角
                  </span>
                </button>
              </div>
            </div>
          </Card>

          {/* Right: KPI + Start Button (1/3, two rows) */}
          <div className="col-span-3 grid grid-rows-2 gap-3 h-full">
            <Card className="h-full border-indigo-100 bg-linear-to-br from-white to-indigo-50/50">
              <div className="flex-1 flex flex-col justify-center items-center">
                <div className="text-6xl font-black text-indigo-600 tabular-nums tracking-tighter drop-shadow-sm">
                  {clickCount.toLocaleString()}
                </div>
                <div className="text-sm font-medium text-slate-400 mt-2">
                  总点击数
                </div>
              </div>
            </Card>

            <button
              onClick={toggleTask}
              className={cn(
                "h-full w-full rounded-2xl shadow-xl flex flex-col items-center justify-center gap-1 transition-all active:scale-[0.98] group relative overflow-hidden",
                isRunning
                  ? "bg-white border-2 border-red-100 hover:border-red-200 text-red-500 hover:bg-red-50"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-300/50"
              )}
            >
              {/* Background decorative glow */}
              {!isRunning && (
                <div className="absolute inset-0 bg-linear-to-tr from-transparent via-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              )}

              {isRunning ? (
                <>
                  <Square className="w-10 h-10 fill-current" />
                  <span className="text-md font-bold tracking-wide">
                    停止任务
                  </span>
                </>
              ) : (
                <>
                  <div className="p-4 bg-white/20 rounded-full group-hover:scale-110 transition-transform backdrop-blur-sm">
                    <Play className="w-8 h-8 fill-current" />
                  </div>
                  <span className="text-md font-bold tracking-wide">
                    启动引擎
                  </span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* Configuration Row */}
        <Card className="col-span-12 row-span-1 bg-white/60">
          <div className="grid grid-cols-[266px_1fr] gap-8 px-1">
            {/* Click Interval */}
            <div className="space-y-2">
              <div className="flex justify-between items-center px-0">
                <span className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-400" /> 每轮间隔
                </span>
                <span className="text-2xl font-light text-slate-900">
                  {clickInterval}
                  <span className="text-sm text-slate-400 ml-1 font-medium">
                    分钟
                  </span>
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="120"
                step="1"
                value={clickInterval}
                disabled={isRunning}
                onChange={(e) => setClickInterval(Number(e.target.value))}
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 disabled:opacity-50"
              />
            </div>

            {/* Scroll Settings */}
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <span className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                  <Monitor className="w-4 h-4 text-slate-400" /> 自动滚动
                </span>
                <div
                  className={cn(
                    "w-10 h-5 rounded-full relative cursor-pointer transition-colors",
                    enableScroll ? "bg-indigo-600" : "bg-slate-300"
                  )}
                  onClick={() => !isRunning && setEnableScroll(!enableScroll)}
                >
                  <div
                    className={cn(
                      "absolute top-1 w-3 h-3 bg-white rounded-full transition-all",
                      enableScroll ? "left-6" : "left-1"
                    )}
                  />
                </div>
              </div>

              <div
                className={cn(
                  "transition-all duration-300 grid grid-cols-2 gap-3",
                  enableScroll
                    ? "opacity-100"
                    : "opacity-30 pointer-events-none"
                )}
              >
                <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
                  <div className="text-xs font-medium text-slate-500 uppercase flex-1 pl-2">
                    每隔
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="w-6 h-6 rounded bg-white shadow-sm flex items-center justify-center hover:bg-slate-100"
                      onClick={() =>
                        setScrollInterval(Math.max(1, scrollInterval - 1))
                      }
                      disabled={isRunning}
                    >
                      -
                    </button>
                    <span className="font-mono font-bold w-6 text-center">
                      {scrollInterval}
                    </span>
                    <button
                      className="w-6 h-6 rounded bg-white shadow-sm flex items-center justify-center hover:bg-slate-100"
                      onClick={() => setScrollInterval(scrollInterval + 1)}
                      disabled={isRunning}
                    >
                      +
                    </button>
                  </div>
                  <div className="text-xs font-medium text-slate-500 pr-2">
                    次点击滚动
                  </div>
                </div>

                <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
                  <div className="text-xs font-medium text-slate-500 uppercase flex-1 pl-2">
                    滚动幅度
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="w-6 h-6 rounded bg-white shadow-sm flex items-center justify-center hover:bg-slate-100"
                      onClick={() =>
                        setScrollAmount(Math.max(1, scrollAmount - 1))
                      }
                      disabled={isRunning}
                    >
                      -
                    </button>
                    <span className="font-mono font-bold w-8 text-center">
                      {scrollAmount}
                    </span>
                    <button
                      className="w-6 h-6 rounded bg-white shadow-sm flex items-center justify-center hover:bg-slate-100"
                      onClick={() =>
                        setScrollAmount(Math.min(50, scrollAmount + 1))
                      }
                      disabled={isRunning}
                    >
                      +
                    </button>
                  </div>
                  <div className="text-xs font-medium text-slate-500 pr-2">
                    行
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </main>

      {/* Footer Log Drawer */}
      <footer className="h-40 bg-white shrink-0 text-slate-600 text-xs font-mono relative overflow-hidden flex flex-col border-t border-slate-200">
        <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-100">
          <span className="flex items-center gap-2 font-bold text-slate-500 uppercase tracking-wider text-[10px]">
            <Activity className="w-3 h-3" /> 系统日志
          </span>
          <span className="text-[10px] opacity-50">v1.0.0</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5 scrollbar-hide select-text cursor-text">
          {logs.length === 0 && (
            <div className="text-slate-400 italic">准备就绪...</div>
          )}
          {logs.map((log) => (
            <div key={log.id} className="flex gap-4 group select-text">
              <span className="opacity-40 w-16 text-right shrink-0">
                {log.time}
              </span>
              <span
                className={cn(
                  "flex-1 wrap-break-word font-medium",
                  log.type === "click" && "text-emerald-600",
                  log.type === "scroll" && "text-purple-600",
                  log.type === "error" && "text-red-500 font-bold",
                  log.type === "info" && "text-blue-500"
                )}
              >
                {log.type === "click" && "➜ "}
                {log.message}
              </span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
        {/* subtle gradient at bottom of logs to fade */}
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-linear-to-t from-white to-transparent pointer-events-none" />
      </footer>
    </div>
  );
}

export default App;
