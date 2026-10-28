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
  ambilight: true,
  ambilightIntensity: 0.55,
  stats: true,
  panel: true,
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

  useEffect(() => {
    setCfg(loadCfg());
    setLive(!!(window as any).__KUJIRA__);
  }, []);

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
