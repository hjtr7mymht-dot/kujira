import { useState, useEffect } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Slider,
  Switch,
  Select,
  SelectItem,
} from "@heroui/react";

const MODES = [
  { key: "off", label: "关闭" },
  { key: "sharp", label: "锐化" },
  { key: "upscale", label: "超分" },
  { key: "framegen", label: "插帧" },
];
const VIEWS = [
  { key: "fit", label: "适应" },
  { key: "fill", label: "填充" },
  { key: "zoom", label: "缩放" },
];
const SCALERS = [
  { key: "auto", label: "自动（按显卡）" },
  { key: "fsr", label: "FSR 1.0" },
  { key: "rcas", label: "RCAS 锐化缩放" },
  { key: "bilinear", label: "双线性" },
];

function KujiraDisplay(props) {
  const [cfg, setCfgState] = useState<any>(null);

  useEffect(() => {
    const api = (window as any).__KUJIRA__;
    if (api) {
      setCfgState({ ...api.cfg() });
    }
  }, []);

  const api = (window as any).__KUJIRA__;
  const set = (k: string, v: any) => {
    setCfgState((prev: any) => ({ ...prev, [k]: v }));
    api && api.setCfg(k, v);
  };

  return (
    <Modal isOpen={true} className="z-100" onClose={props.onClose}>
      <ModalContent>
        <>
          <ModalHeader className="flex flex-col gap-1">Kujira 画质</ModalHeader>
          <ModalBody>
            {!cfg || !api ? (
              <div className="text-sm text-default-500">后处理引擎未加载</div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm">后处理模式</span>
                  <div className="flex gap-1">
                    {MODES.map((m) => (
                      <Button
                        key={m.key}
                        size="sm"
                        variant={cfg.mode === m.key ? "solid" : "bordered"}
                        color={cfg.mode === m.key ? "primary" : "default"}
                        onPress={() => set("mode", m.key)}
                      >
                        {m.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm">视图模式</span>
                  <div className="flex gap-1">
                    {VIEWS.map((m) => (
                      <Button
                        key={m.key}
                        size="sm"
                        variant={cfg.viewMode === m.key ? "solid" : "bordered"}
                        color={cfg.viewMode === m.key ? "primary" : "default"}
                        onPress={() => set("viewMode", m.key)}
                      >
                        {m.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <Select
                  label="超分方案"
                  size="sm"
                  selectedKeys={[cfg.scaler || "auto"]}
                  onSelectionChange={(keys: any) => {
                    const v = Array.from(keys)[0];
                    if (v) set("scaler", v);
                  }}
                >
                  {SCALERS.map((s) => (
                    <SelectItem key={s.key}>{s.label}</SelectItem>
                  ))}
                </Select>

                <Slider
                  label="锐度"
                  step={0.05}
                  maxValue={1}
                  minValue={0}
                  value={cfg.sharpness ?? 0.45}
                  className="max-w-md"
                  onChange={(v: any) => set("sharpness", v)}
                />

                <div className="flex items-center justify-between">
                  <span className="text-sm">环境光</span>
                  <Switch
                    isSelected={!!cfg.ambilight}
                    onValueChange={(v: boolean) => set("ambilight", v)}
                    size="sm"
                  />
                </div>

                <Slider
                  label="光强"
                  step={0.05}
                  maxValue={1}
                  minValue={0}
                  value={cfg.ambilightIntensity ?? 0.55}
                  className="max-w-md"
                  onChange={(v: any) => set("ambilightIntensity", v)}
                />

                <div className="flex items-center justify-between">
                  <span className="text-sm">性能 HUD</span>
                  <Switch
                    isSelected={!!cfg.stats}
                    onValueChange={(v: boolean) => set("stats", v)}
                    size="sm"
                  />
                </div>
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button color="primary" onPress={props.onClose}>
              完成
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
    </Modal>
  );
}

export default KujiraDisplay;
