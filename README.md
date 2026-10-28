# Kujira 🐋

**免费的 Xbox 串流客户端** —— 把付费墙里的功能全都做成免费的。

macOS / Windows 双平台，支持 Xbox Remote Play（主机串流）与 xCloud（云游戏）。

## 特性

- **运动补偿插帧**：自研光流引擎（块匹配 + 亚像素细化），60fps 源可输出至显示器满刷新
  （180Hz 面板实测 60→180fps），画质比帧混合高一倍（SAD 1.11 vs 2.25）
- **FSR 1.0 超分**：AMD EASU + RCAS 官方算法（MIT），边缘自适应上采样 + 对比度自适应锐化
- **环境光溢出**（Ambilight）、**视图模式**（适应 / 填充 / 放大 1.25×）
- **TURN 中继远程**：打洞失败自动走中继，严格 NAT / CGNAT 下也能远程串流，无需端口转发
- 1080p 主机串流、手柄振动 / 扳机震动、成就系统、IPv6、键鼠映射

## 使用

设置面板：串流页右下角或 `⌥K` 呼出。快捷键：`⌥1/2/3` 视图模式，`⌥F` 切换后处理，
`⌥S` 状态面板，`⌥E` 总开关。

## 构建

```bash
npm install        # 国内建议加 --registry=https://registry.npmmirror.com
npm run build      # 产物在 dist/
```

## 致谢与许可

基于 [XStreamingDesktop](https://github.com/Geocld/XStreaming-desktop) v1.10.2（MIT，
上游 README 存档于 [README.upstream.md](./README.upstream.md)），播放核心为
[xstreaming-player](https://www.npmjs.com/package/xstreaming-player)（MIT），
超分着色器来自 AMD FidelityFX FSR v1.0.2（MIT）。详见 [NOTICE](./NOTICE)。

本项目以 MIT 协议发布。

> DISCLAIMER: This project is not affiliated with Microsoft or Xbox.
> All rights and trademarks are property of their respective owners.
