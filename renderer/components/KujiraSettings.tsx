import { Card, CardBody, Select, SelectItem, Slider, Switch } from "@heroui/react";
import { useEffect, useState } from "react";

// Kujira PostFX engine settings — persisted to localStorage 'kujira.config',
// applied live on the stream page through window.__KUJIRA__ when present.
const DEFAULTS = {
  enabled: true,
  mode: "framegen", // 'off' | 'sharp' | 'upscale' | 'framegen'
  framegen: "mc", // 'mc' | 'blend'
  sharpness: 0.45,
  viewMode: "fill", // 'fit' | 'fill' | 'zoom'
  scaler: "auto", // 'auto' | 'fsr' | 'rcas' | 'bilinear' 
  ambilight: true,
  ambilightIntensity: 0.55,
  stats: true,
  panel: true,
  outputRes: "screen", // 'screen' | '1080p' | '1440p' | '4K'
  outputHz: "screen", // 'screen' | 60 | 90 | 120 | 144 | 180 | 240
};
const CFG_KEY = "kujira.config";

function loadCfg(): typeof DEFAULTS {
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    // corrupted config -> fall back to defaults
    return { ...DEFAULTS };
  }
}

function Row(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 border-b border-divider last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{props.label}</p>
        {props.hint && <p className="text-xs text-default-400">{props.hint}</p>}
      </div>
      <div className="min-w-[180px] flex justify-end">{props.children}</div>
    </div>
  );
}

export default function KujiraSettings() {
  const [cfg, setCfg] = useState(DEFAULTS);
  const [live, setLive] = useState(false);
  const [gpu, setGpu] = useState({ vendor: "other", renderer: "" });

  useEffect(() => {
    setCfg(loadCfg());
    setLive(!!(window as any).__KUJIRA__);
    try {
      const g = document.createElement("canvas").getContext("webgl2");
      const ext = g && g.getExtension("WEBGL_debug_renderer_info");
      const renderer = ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
      const s = renderer.toLowerCase();
      const vendor = /nvidia|geforce|\brtx\b|\bgtx\b/.test(s) ? "nvidia"
        : /amd|radeon/.test(s) ? "amd"
        : /intel/.test(s) ? "intel"
        : /apple/.test(s) ? "apple" : "other";
      setGpu({ vendor, renderer });
    } catch {
      setGpu({ vendor: "other", renderer: "" });
    }
  }, []);

  const gpuNote: Record<string, string> = {
    nvidia: "N 卡专属：可在 NVIDIA 控制面板开启驱动级「视频超分辨率」；DLSS/XeSS 需引擎运动矢量，串流协议无法提供",
    amd: "A 卡：FSR 1.0（EASU+RCAS）为最优空间超分；驱动面板亦有视频平滑处理可开",
    intel: "I 卡：FSR 1.0 全厂商通用；核显建议输出分辨率档不超过 1440p",
    apple: "Apple GPU：FSR 1.0 已按 Metal 友好路径运行；4K 超采样档可放心开",
    other: "未识别显卡：已回退 FSR 1.0 全厂商路径",
  };

  const update = (key: string, value: unknown) => {
    setCfg((prev) => {
      const next = { ...prev, [key]: value };
      try {
        window.localStorage.setItem(CFG_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable (private mode etc.) -> keep in-memory only
      }
      const api = (window as any).__KUJIRA__;
      if (api && api.setCfg) api.setCfg(key, value);
      return next;
    });
  };

  return (
    <Card className="mt-2">
      <CardBody className="px-5 py-2">
        <div className="flex items-center gap-2 pb-1 pt-2">
          <p className="text-base font-semibold">Kujira 画质引擎</p>
          <p className="text-xs text-default-400">
            {live ? "● 引擎在线，改动实时生效" : "改动将在下次串流时生效"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-1 text-xs text-default-400">
          <span className="bg-white/5 border border-white/10 rounded-full px-2 py-0.5">
            GPU: {gpu.renderer ? gpu.renderer.slice(0, 48) : "检测中..."}
          </span>
          <span className="bg-sky-500/10 border border-sky-500/20 text-sky-300 rounded-full px-2 py-0.5">
            {gpuNote[gpu.vendor]}
          </span>
        </div>

        <Row label="后处理模式" hint="插帧：60fps 源输出满刷新率；超分：FSR 上采样">
          <Select
            size="sm"
            className="w-[180px]"
            selectedKeys={[cfg.mode]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) update("mode", v);
            }}
          >
            <SelectItem key="off">关</SelectItem>
            <SelectItem key="sharp">锐化</SelectItem>
            <SelectItem key="upscale">超分</SelectItem>
            <SelectItem key="framegen">插帧</SelectItem>
          </Select>
        </Row>

        <Row label="插帧算法" hint="运动补偿画质更高，帧混合延迟更低">
          <Select
            size="sm"
            className="w-[180px]"
            isDisabled={cfg.mode !== "framegen"}
            selectedKeys={[cfg.framegen]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) update("framegen", v);
            }}
          >
            <SelectItem key="mc">运动补偿</SelectItem>
            <SelectItem key="blend">帧混合</SelectItem>
          </Select>
        </Row>

        <Row label="视图模式">
          <Select
            size="sm"
            className="w-[180px]"
            selectedKeys={[cfg.viewMode]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) update("viewMode", v);
            }}
          >
            <SelectItem key="fit">适应</SelectItem>
            <SelectItem key="fill">填充</SelectItem>
            <SelectItem key="zoom">放大</SelectItem>
          </Select>
        </Row>

        <Row label="超分方案" hint="跟随显卡 = 自动选该厂商当前最优方案">
          <Select
            size="sm"
            className="w-[180px]"
            selectedKeys={[String(cfg.scaler || "auto")]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) update("scaler", v);
            }}
          >
            <SelectItem key="auto">跟随显卡</SelectItem>
            <SelectItem key="fsr">FSR 1.0 (EASU+RCAS)</SelectItem>
            <SelectItem key="rcas">RCAS 锐化缩放</SelectItem>
            <SelectItem key="bilinear">双线性（低负载）</SelectItem>
          </Select>
        </Row>

        <Row label="输出分辨率" hint="纹理与后处理管线的分辨率档，4K 为超采样输出">
          <Select
            size="sm"
            className="w-[180px]"
            selectedKeys={[String(cfg.outputRes)]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) update("outputRes", v === "screen" ? "screen" : v);
            }}
          >
            <SelectItem key="screen">跟随屏幕</SelectItem>
            <SelectItem key="1080p">1080p</SelectItem>
            <SelectItem key="1440p">1440p</SelectItem>
            <SelectItem key="4K">4K (3840×2160)</SelectItem>
          </Select>
        </Row>

        <Row label="输出刷新率" hint="插帧输出上限，不超过屏幕实际刷新率">
          <Select
            size="sm"
            className="w-[180px]"
            selectedKeys={[String(cfg.outputHz)]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (!v) return;
              update("outputHz", v === "screen" ? "screen" : Number(v));
            }}
          >
            <SelectItem key="screen">跟随屏幕</SelectItem>
            <SelectItem key="60">60Hz</SelectItem>
            <SelectItem key="90">90Hz</SelectItem>
            <SelectItem key="120">120Hz</SelectItem>
            <SelectItem key="144">144Hz</SelectItem>
            <SelectItem key="180">180Hz</SelectItem>
            <SelectItem key="240">240Hz</SelectItem>
          </Select>
        </Row>

        <Row label="锐度">
          <Slider
            className="w-[180px]"
            size="sm"
            step={0.05}
            minValue={0}
            maxValue={1}
            value={cfg.sharpness}
            onChange={(v) => update("sharpness", Number(v))}
          />
        </Row>

        <Row label="环境光" hint="画面色彩溢出到窗口背景">
          <Switch
            size="sm"
            isSelected={cfg.ambilight}
            onValueChange={(v) => update("ambilight", v)}
          />
        </Row>

        <Row label="光强">
          <Slider
            className="w-[180px]"
            size="sm"
            step={0.05}
            minValue={0}
            maxValue={1}
            value={cfg.ambilightIntensity}
            onChange={(v) => update("ambilightIntensity", Number(v))}
          />
        </Row>

        <Row label="性能 HUD" hint="串流页左上角帧率与延迟">
          <Switch
            size="sm"
            isSelected={cfg.stats}
            onValueChange={(v) => update("stats", v)}
          />
        </Row>

        <Row label="悬浮面板" hint="串流页内的 Kujira 控制面板">
          <Switch
            size="sm"
            isSelected={cfg.panel}
            onValueChange={(v) => update("panel", v)}
          />
        </Row>
      </CardBody>
    </Card>
  );
}
