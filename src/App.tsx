import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Play,
  Square,
  RotateCcw,
  MousePointer,
  Settings,
  FileText,
  Target,
  Monitor,
  Clock,
  Mouse,
} from "lucide-react";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";
import "./App.css";

// Helper for classes
function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

type Area = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type LogEntry = {
  time: string;
  type: "click" | "scroll" | "info" | "error";
  message: string;
};

function App() {
  // State
  const [regionName, setRegionName] = useState("");
  const [area, setArea] = useState<Area | null>(null);
  const [captureStep, setCaptureStep] = useState<
    "none" | "topLeft" | "bottomRight"
  >("none");
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);

  const [clickInterval, setClickInterval] = useState(30); // minutes
  const [enableScroll, setEnableScroll] = useState(true);
  const [scrollInterval, setScrollInterval] = useState(5); // clicks

  const [isRunning, setIsRunning] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // Event Listeners
  useEffect(() => {
    let unlistenClick: () => void;
    let unlistenScroll: () => void;
    let unlistenStop: () => void;

    const setupListeners = async () => {
      unlistenClick = await listen("click-event", (event: any) => {
        const payload = event.payload;
        setClickCount(payload.count);
        addLog({
          time: payload.time,
          type: "click",
          message: `Click #${payload.count} at (${payload.x}, ${payload.y})`,
        });
      });

      unlistenScroll = await listen("scroll-event", (event: any) => {
        const payload = event.payload;
        addLog({
          time: payload.time,
          type: "scroll",
          message: `Scrolled ${payload.direction}`,
        });
      });

      unlistenStop = await listen("auto-stopped", () => {
        setIsRunning(false);
        addLog({
          time: new Date().toLocaleTimeString(),
          type: "info",
          message: "Task stopped",
        });
      });
    };

    setupListeners();

    return () => {
      if (unlistenClick) unlistenClick();
      if (unlistenScroll) unlistenScroll();
      if (unlistenStop) unlistenStop();
    };
  }, []);

  const addLog = (log: LogEntry) => {
    setLogs((prev) => {
      const newLogs = [...prev, log];
      if (newLogs.length > 20) {
        return newLogs.slice(newLogs.length - 20);
      }
      return newLogs;
    });
  };

  // Helper: Countdown Capture
  const startCaptureSequence = (step: "topLeft" | "bottomRight") => {
    setCaptureStep(step);
    setCaptureCountdown(3);
  };

  useEffect(() => {
    if (captureCountdown === null) return;

    if (captureCountdown > 0) {
      const timer = setTimeout(() => {
        setCaptureCountdown((prev) => (prev !== null ? prev - 1 : null));
      }, 1000);
      return () => clearTimeout(timer);
    }

    if (captureCountdown === 0) {
      // Execute capture
      captureCurrentPosition();
      setCaptureCountdown(null);
    }
  }, [captureCountdown]);

  const captureCurrentPosition = async () => {
    try {
      const pos: [number, number] = await invoke("get_mouse_position");
      const [x, y] = pos;

      if (captureStep === "topLeft") {
        setArea((prev) => ({
          x1: x,
          y1: y,
          x2: prev?.x2 ?? 0,
          y2: prev?.y2 ?? 0,
        }));
        addLog({
          time: new Date().toLocaleTimeString(),
          type: "info",
          message: `Captured Top-Left: ${x}, ${y}`,
        });
      } else if (captureStep === "bottomRight") {
        setArea((prev) => ({
          x1: prev?.x1 ?? 0,
          y1: prev?.y1 ?? 0,
          x2: x,
          y2: y,
        }));
        addLog({
          time: new Date().toLocaleTimeString(),
          type: "info",
          message: `Captured Bottom-Right: ${x}, ${y}`,
        });
        setCaptureStep("none");
      }
    } catch (err) {
      console.error(err);
      addLog({
        time: new Date().toLocaleTimeString(),
        type: "error",
        message: `Capture failed: ${err}`,
      });
    }
  };

  const startTask = async () => {
    if (!area || (area.x1 === 0 && area.x2 === 0)) {
      addLog({
        time: new Date().toLocaleTimeString(),
        type: "error",
        message: "Please define an area first",
      });
      return;
    }

    try {
      await invoke("start_clicking", {
        config: {
          area: { x1: area.x1, y1: area.y1, x2: area.x2, y2: area.y2 },
          interval: clickInterval,
          enable_scroll: enableScroll,
          scroll_interval: scrollInterval,
        },
      });
      setIsRunning(true);
      setClickCount(0); // Reset UI count
      addLog({
        time: new Date().toLocaleTimeString(),
        type: "info",
        message: "Task Started",
      });
    } catch (err: any) {
      addLog({
        time: new Date().toLocaleTimeString(),
        type: "error",
        message: `Start failed: ${err}`,
      });
    }
  };

  const stopTask = async () => {
    try {
      await invoke("stop_clicking");
      setIsRunning(false);
    } catch (err) {
      console.error(err);
    }
  };

  const resetParams = () => {
    setRegionName("");
    setArea(null);
    setCaptureStep("none");
    setClickInterval(30);
    setEnableScroll(true);
    setScrollInterval(5);
    setClickCount(0);
    setLogs([]);
  };

  // Derived
  const areaWidth = area ? Math.abs(area.x2 - area.x1) : 0;
  const areaHeight = area ? Math.abs(area.y2 - area.y1) : 0;
  const estimatedRows = Math.floor(areaHeight / 40);

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col font-sans text-slate-800 overflow-hidden select-none">
      {/* Header */}
      <header className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white p-4 shadow-md flex items-center gap-3">
        <MousePointer className="w-6 h-6" />
        <h1 className="text-xl font-bold tracking-wide">自动点击助手 v1.0</h1>
      </header>

      <main className="flex-1 flex gap-4 p-4 overflow-hidden">
        {/* Left Column: Controls & Config */}
        <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-2">
          {/* Region Section */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4 text-purple-700">
              <Target className="w-5 h-5" />
              <h2 className="font-semibold text-lg">区域定位</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">
                  地区/列表名称
                </label>
                <input
                  type="text"
                  value={regionName}
                  onChange={(e) => setRegionName(e.target.value)}
                  placeholder="例如：上海电信服务器列表"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none transition-all"
                  disabled={isRunning}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => startCaptureSequence("topLeft")}
                  disabled={isRunning}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-lg border-2 border-dashed transition-all",
                    captureStep === "topLeft"
                      ? "border-purple-500 bg-purple-50 text-purple-700 animate-pulse"
                      : "border-gray-200 hover:border-purple-300 text-gray-500 hover:bg-gray-50",
                    isRunning && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {captureStep === "topLeft" && captureCountdown !== null ? (
                    <span className="text-2xl font-bold">
                      {captureCountdown}
                    </span>
                  ) : (
                    <>
                      <Mouse className="w-6 h-6 mb-2" />
                      <span className="text-sm font-medium">捕获左上角</span>
                      {area?.x1 !== undefined && (
                        <span className="text-xs mt-1 text-gray-400">
                          ({area?.x1 ?? 0}, {area?.y1 ?? 0})
                        </span>
                      )}
                    </>
                  )}
                </button>

                <button
                  onClick={() => startCaptureSequence("bottomRight")}
                  disabled={isRunning}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-lg border-2 border-dashed transition-all",
                    captureStep === "bottomRight"
                      ? "border-purple-500 bg-purple-50 text-purple-700 animate-pulse"
                      : "border-gray-200 hover:border-purple-300 text-gray-500 hover:bg-gray-50",
                    isRunning && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {captureStep === "bottomRight" &&
                  captureCountdown !== null ? (
                    <span className="text-2xl font-bold">
                      {captureCountdown}
                    </span>
                  ) : (
                    <>
                      <Monitor className="w-6 h-6 mb-2" />
                      <span className="text-sm font-medium">捕获右下角</span>
                      {area?.x2 !== undefined && (
                        <span className="text-xs mt-1 text-gray-400">
                          ({area?.x2 ?? 0}, {area?.y2 ?? 0})
                        </span>
                      )}
                    </>
                  )}
                </button>
              </div>

              {area?.x2 !== undefined && areaWidth > 0 && (
                <div className="bg-indigo-50 p-3 rounded-md text-sm text-indigo-800 flex justify-between">
                  <span>
                    尺寸: {areaWidth} x {areaHeight}
                  </span>
                  <span>约 {estimatedRows} 行</span>
                </div>
              )}
            </div>
          </section>

          {/* Config Section */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4 text-purple-700">
              <Settings className="w-5 h-5" />
              <h2 className="font-semibold text-lg">参数配置</h2>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">
                  点击间隔 (分钟)
                </label>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={clickInterval}
                    onChange={(e) => setClickInterval(Number(e.target.value))}
                    disabled={isRunning}
                    className="w-20 px-2 py-1 border rounded-md text-center"
                  />
                </div>
              </div>

              <div className="border-t border-gray-100 my-1"></div>

              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">
                  启用列表滚动
                </label>
                <button
                  onClick={() => !isRunning && setEnableScroll(!enableScroll)}
                  className={cn(
                    "w-12 h-6 rounded-full p-1 transition-colors relative",
                    enableScroll ? "bg-purple-600" : "bg-gray-300"
                  )}
                  disabled={isRunning}
                >
                  <div
                    className={cn(
                      "w-4 h-4 bg-white rounded-full transition-transform",
                      enableScroll ? "translate-x-6" : "translate-x-0"
                    )}
                  />
                </button>
              </div>

              {enableScroll && (
                <div className="flex items-center justify-between bg-gray-50 p-3 rounded-lg animate-in slide-in-from-top-2 fade-in">
                  <label className="text-sm text-gray-600">
                    滚动触发间隔 (次点击)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={scrollInterval}
                    onChange={(e) => setScrollInterval(Number(e.target.value))}
                    disabled={isRunning}
                    className="w-16 px-2 py-1 border rounded-md text-center bg-white"
                  />
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Status & Logs */}
        <div className="flex-1 flex flex-col gap-4">
          {/* Control & Status */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex flex-col items-center justify-center gap-6">
            <div className="flex items-center gap-6 w-full justify-center">
              <div className="text-center">
                <div className="text-sm text-gray-500 mb-1">运行状态</div>
                <div
                  className={cn(
                    "flex items-center gap-2 font-bold text-lg",
                    isRunning ? "text-green-600" : "text-gray-400"
                  )}
                >
                  <div
                    className={cn(
                      "w-3 h-3 rounded-full",
                      isRunning ? "bg-green-500 animate-pulse" : "bg-gray-300"
                    )}
                  />
                  {isRunning ? "运行中" : "已停止"}
                </div>
              </div>
              <div className="h-10 w-px bg-gray-200"></div>
              <div className="text-center">
                <div className="text-sm text-gray-500 mb-1">累计点击</div>
                <div className="font-mono text-2xl font-bold text-indigo-600">
                  {clickCount}
                </div>
              </div>
            </div>

            <div className="flex w-full gap-3">
              {!isRunning ? (
                <button
                  onClick={startTask}
                  className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white py-3 px-6 rounded-lg font-semibold shadow-lg shadow-purple-200 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <Play className="w-5 h-5 fill-current" /> 开始任务
                </button>
              ) : (
                <button
                  onClick={stopTask}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 px-6 rounded-lg font-semibold shadow-lg shadow-red-200 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <Square className="w-5 h-5 fill-current" /> 停止任务
                </button>
              )}

              <button
                onClick={resetParams}
                disabled={isRunning}
                className="px-4 border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors disabled:opacity-50"
                title="重置"
              >
                <RotateCcw className="w-5 h-5" />
              </button>
            </div>
          </section>

          {/* Logs */}
          <section className="flex-1 bg-white rounded-xl shadow-sm border border-gray-100 p-0 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-gray-100 flex items-center gap-2 text-gray-700 bg-gray-50">
              <FileText className="w-4 h-4" />
              <h3 className="font-semibold text-sm">运行日志</h3>
            </div>
            <div className="flex-1 p-4 overflow-y-auto space-y-2 font-mono text-sm bg-slate-50">
              {logs.length === 0 && (
                <div className="text-center text-gray-400 py-10 italic">
                  暂无日志记录...
                </div>
              )}
              {logs.map((log, i) => (
                <div
                  key={i}
                  className="flex gap-3 hover:bg-white p-1 rounded transition-colors border border-transparent hover:border-gray-100"
                >
                  <span className="text-gray-400 text-xs mt-1">{log.time}</span>
                  <div className="flex-1">
                    {log.type === "click" && (
                      <span className="text-blue-600">● 点击: </span>
                    )}
                    {log.type === "scroll" && (
                      <span className="text-purple-600">⇅ 滚动: </span>
                    )}
                    {log.type === "info" && (
                      <span className="text-green-600">info: </span>
                    )}
                    {log.type === "error" && (
                      <span className="text-red-500">err: </span>
                    )}
                    <span className="text-gray-700">{log.message}</span>
                  </div>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
