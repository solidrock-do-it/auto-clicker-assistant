import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Play,
  Square,
  Focus,
  Activity,
  Zap,
  Clock,
  Mouse,
  Monitor,
  MapPin,
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
      "bg-white rounded-2xl p-5 shadow-sm border border-slate-100/50 flex flex-col",
      className
    )}
  >
    {title && (
      <div className="flex items-center gap-2 mb-4 text-slate-400 uppercase tracking-widest text-[10px] font-bold">
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
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [endPoint, setEndPoint] = useState<Point | null>(null);
  const [captureStep, setCaptureStep] = useState<
    "none" | "topLeft" | "bottomRight"
  >("none");
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);

  const [clickInterval, setClickInterval] = useState(30);
  const [enableScroll, setEnableScroll] = useState(true);
  const [scrollInterval, setScrollInterval] = useState(5);
  const [scrollAmount, setScrollAmount] = useState(12);

  const [isRunning, setIsRunning] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdCounter = useRef(0);
  const [privilegeInfo, setPrivilegeInfo] = useState<string>("检查中...");

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Check privileges on mount
  useEffect(() => {
    invoke<string>("check_privileges")
      .then((info) => setPrivilegeInfo(info))
      .catch(() => setPrivilegeInfo("检查失败"));
  }, []);

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
        addLog("info", "任务已自动停止");
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
    setCaptureStep(step);
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
          if (captureStep === "topLeft") {
            setStartPoint({ x, y });
            addLog("info", `起点设定: ${x},${y}`);
          } else if (captureStep === "bottomRight") {
            setEndPoint({ x, y });
            addLog("info", `终点设定: ${x},${y}`);
          }
        })
        .catch((e: any) => {
          addLog("error", `获取鼠标坐标失败: ${String(e)}`);
        })
        .finally(() => {
          setCaptureStep("none");
          setCaptureCountdown(null);
        });
    }
  }, [captureCountdown]);

  const area: Area | null =
    startPoint && endPoint
      ? { x1: startPoint.x, y1: startPoint.y, x2: endPoint.x, y2: endPoint.y }
      : null;

  const testClickHere = async () => {
    try {
      const result = await invoke<string>("test_click_here");
      addLog("info", result);
    } catch (e: any) {
      addLog("error", `测试失败: ${String(e)}`);
    }
  };

  // Task Control
  const toggleTask = async () => {
    if (isRunning) {
      await invoke("stop_clicking");
      setIsRunning(false);
      addLog("info", "用户已停止任务");
    } else {
      if (!startPoint || !endPoint || !area) {
        addLog("error", "请先设置区域的起点和终点");
        return;
      }
      if (startPoint.x === endPoint.x || startPoint.y === endPoint.y) {
        addLog("error", "区域无效：起点/终点不能在同一直线");
        return;
      }
      try {
        await invoke("start_clicking", {
          config: {
            area,
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
      <header className="h-16 px-8 flex items-center justify-between bg-white border-b border-slate-100 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-lg shadow-indigo-200">
            <Mouse className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight text-slate-900 leading-tight">
              自动点击助手
            </h1>
            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
              解放双手，自动完成重复点击任务 V1.0
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

          <div className="text-xs text-slate-500 border-l border-slate-200 pl-3">
            {privilegeInfo}
          </div>
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
        {/* KPI Card */}
        <Card
          className="col-span-12 md:col-span-4 row-span-1 border-indigo-100 bg-linear-to-br from-white to-indigo-50/50"
          icon={Activity}
          title="活动统计"
        >
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="text-6xl font-black text-indigo-600 tabular-nums tracking-tighter drop-shadow-sm">
              {clickCount.toLocaleString()}
            </div>
            <div className="text-sm font-medium text-slate-400 mt-2">
              总点击数
            </div>
          </div>
        </Card>

        {/* Region Card */}
        <div className="col-span-12 md:col-span-8 row-span-1 grid grid-cols-2 gap-6 h-full">
          <Card icon={MapPin} title="目标区域" className="h-full">
            <div className="flex-1 flex flex-col gap-4">
              {/* <input
                className="w-full bg-slate-50 border-none rounded-lg px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all placeholder:text-slate-400"
                placeholder="区域名 (可选)"
                value={regionName}
                onChange={(e) => setRegionName(e.target.value)}
                disabled={isRunning}
              /> */}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    起点
                  </div>
                  <div className="font-mono text-slate-700 mt-1">
                    {startPoint ? `${startPoint.x}, ${startPoint.y}` : "未设置"}
                  </div>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    终点
                  </div>
                  <div className="font-mono text-slate-700 mt-1">
                    {endPoint ? `${endPoint.x}, ${endPoint.y}` : "未设置"}
                  </div>
                </div>
              </div>

              <div className="flex-1 grid grid-cols-2 gap-3">
                <button
                  disabled={isRunning}
                  onClick={() => startCapture("topLeft")}
                  className={cn(
                    "rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all hover:bg-slate-50",
                    captureStep === "topLeft"
                      ? "border-indigo-500 bg-indigo-50/50 text-indigo-600 animate-pulse"
                      : "border-slate-200 text-slate-400"
                  )}
                >
                  <div className="grid place-items-center grid-cols-2">
                    {captureStep === "topLeft" && captureCountdown !== null ? (
                      <div className="text-2xl font-bold">
                        {captureCountdown}
                      </div>
                    ) : (
                      <Focus className="w-5 h-5 opacity-70" />
                    )}
                    <span className="text-xs font-bold uppercase">左上角</span>
                  </div>
                </button>
                <button
                  disabled={isRunning}
                  onClick={() => startCapture("bottomRight")}
                  className={cn(
                    "rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all hover:bg-slate-50",
                    captureStep === "bottomRight"
                      ? "border-indigo-500 bg-indigo-50/50 text-indigo-600 animate-pulse"
                      : "border-slate-200 text-slate-400"
                  )}
                >
                  <div className="grid place-items-center grid-cols-2 h-8">
                    {captureStep === "bottomRight" &&
                    captureCountdown !== null ? (
                      <div className="text-2xl font-bold">
                        {captureCountdown}
                      </div>
                    ) : (
                      <Focus className="w-5 h-5 opacity-70" />
                    )}
                    <span className="text-xs font-bold uppercase">右下角</span>
                  </div>
                </button>
              </div>
            </div>
          </Card>

          {/* Action Button Area - Massive Button */}
          <button
            onClick={toggleTask}
            className={cn(
              "rounded-2xl shadow-xl flex flex-col items-center justify-center gap-3 transition-all active:scale-[0.98] group relative overflow-hidden",
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
                <span className="text-lg font-bold tracking-wide">
                  停止任务
                </span>
              </>
            ) : (
              <>
                <div className="p-4 bg-white/20 rounded-full mb-1 group-hover:scale-110 transition-transform backdrop-blur-sm">
                  <Play className="w-8 h-8 fill-current ml-1" />
                </div>
                <span className="text-lg font-bold tracking-wide">
                  启动引擎
                </span>
              </>
            )}
          </button>
        </div>

        {/* Configuration Row */}
        <Card
          className="col-span-12 row-span-1 bg-white/60"
          icon={Zap}
          title="配置"
        >
          <div className="grid grid-cols-[200px_1fr] gap-8 px-2">
            {/* Click Interval */}
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <span className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-400" /> 点击间隔
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
