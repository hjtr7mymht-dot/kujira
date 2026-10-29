// [KUJIRA] core engine — runs in page main world (also loaded by test/harness.html)
(() => {
  'use strict';
  if (window.__KUJIRA__) return;
  const VERSION = '0.1.0';

  // ============================== config ==============================
  const DEFAULTS = {
    enabled: true,
    mode: 'framegen',        // 'off' | 'sharp' | 'upscale' | 'framegen'
    framegen: 'mc',          // 'mc' (motion compensated) | 'blend'
    sharpness: 0.45,         // 0..1
    viewMode: 'fill',        // 'fit' | 'fill' | 'zoom'
    ambilight: true,
    ambilightIntensity: 0.55,
    stats: true,
    panel: false, // Kujira: hidden by default, opened from the stream menu
    hudOpacity: 0.85,     // HUD text opacity 0.3..1
    scaler: 'auto',        // 'auto' | 'fsr' | 'rcas' | 'bilinear' — upscaler choice (vendor-aware auto)
    outputRes: 'screen',   // 'screen' | '1080p' | '1440p' | '4K' (long-edge supersample tiers)
    outputHz: 'screen',    // 'screen' | 60 | 90 | 120 | 144 | 180 | 240 (output refresh cap)
  };
  const CFG_KEY = 'kujira.config';
  let cfg = Object.assign({}, DEFAULTS);
  // ---- GPU detection (vendor-aware scaler selection) ----
  const GPU = (() => {
    try {
      const g = document.createElement('canvas').getContext('webgl2');
      const ext = g && g.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      const vendorStr = ext ? String(g.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '';
      const s = (renderer + ' ' + vendorStr).toLowerCase();
      const vendor = /nvidia|geforce|\brtx\b|\bgtx\b/.test(s) ? 'nvidia'
                   : /amd|radeon/.test(s) ? 'amd'
                   : /intel/.test(s) ? 'intel'
                   : /apple/.test(s) ? 'apple' : 'other';
      return { vendor, renderer };
    } catch (e) {
      return { vendor: 'other', renderer: '' };
    }
  })();
  function effectiveScaler() {
    if (cfg.scaler && cfg.scaler !== 'auto') return cfg.scaler;
    // auto: best real option per vendor today (NIS lands when the compute port is done)
    return 'fsr';
  }
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
  } catch (e) {}
  function saveCfg() {
    try { window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  // ============================== GLSL ==============================
  const VS = `#version 300 es
  out vec2 vUv;
  void main() {
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
  }`;

  const FS_LUMA = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc;
  uniform vec2 uStep; // source step for smoothing
  void main() {
    float l = 0.0;
    l += dot(texture(uSrc, vUv + vec2(-1.0, -1.0) * uStep).rgb, vec3(0.299, 0.587, 0.114));
    l += dot(texture(uSrc, vUv + vec2( 1.0, -1.0) * uStep).rgb, vec3(0.299, 0.587, 0.114));
    l += dot(texture(uSrc, vUv + vec2(-1.0,  1.0) * uStep).rgb, vec3(0.299, 0.587, 0.114));
    l += dot(texture(uSrc, vUv + vec2( 1.0,  1.0) * uStep).rgb, vec3(0.299, 0.587, 0.114));
    o = vec4(l * 0.25, 0.0, 0.0, 1.0);
  }`;

  // block-matching optical flow, prev -> cur, output in uv units (sub-pixel refined)
  const FS_FLOW = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uPrev;
  uniform sampler2D uCur;
  uniform vec2 uTexel; // 1/lumRes
  float sad(vec2 uv, vec2 off) {
    float s = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec2 n = vec2(float(i), float(j)) * 1.5;
        float a = texture(uPrev, uv + n * uTexel).r;
        float b = texture(uCur, uv + n * uTexel + off * uTexel).r;
        s += abs(a - b);
      }
    }
    return s;
  }
  float refine(float sm, float s0, float sp) {
    float d = sm - sp;
    float e = sm - 2.0 * s0 + sp;
    if (abs(e) < 1e-6) return 0.0;
    return clamp(d / (2.0 * e), -1.0, 1.0);
  }
  void main() {
    vec2 best = vec2(0.0);
    float bestS = 1e9;
    // penalized score: SAD + small motion prior, so flat regions fall back to zero flow
    const float LAMBDA = 0.006;
    for (int dy = -8; dy <= 8; dy += 2) {
      for (int dx = -8; dx <= 8; dx += 2) {
        vec2 off = vec2(float(dx), float(dy));
        float s = sad(vUv, off) + LAMBDA * (abs(off.x) + abs(off.y));
        if (s < bestS) { bestS = s; best = off; }
      }
    }
    vec2 base = best;
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        vec2 cand = base + vec2(float(dx), float(dy));
        float s = sad(vUv, cand) + LAMBDA * (abs(cand.x) + abs(cand.y));
        if (s < bestS) { bestS = s; best = cand; }
      }
    }
    // sub-pixel parabolic refinement
    float s0 = sad(vUv, best);
    float fx = refine(sad(vUv, best + vec2(-1.0, 0.0)), s0, sad(vUv, best + vec2(1.0, 0.0)));
    float fy = refine(sad(vUv, best + vec2(0.0, -1.0)), s0, sad(vUv, best + vec2(0.0, 1.0)));
    o = vec4((best + vec2(fx, fy)) * uTexel, 0.0, 1.0);
  }`;

  // pack flow into RGBA8 for CPU readback (diagnostics)
  const FS_PACK = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc;
  void main() {
    vec2 f = texture(uSrc, vUv).xy;
    o = vec4(clamp(f * 4.0 + 0.5, 0.0, 1.0), 0.0, 1.0);
  }`;


  // ===== AMD FidelityFX FSR v1.0.2 (MIT) - EASU upscale + RCAS sharpen =====
// Source: AMD reference GLSL (MIT), adapted for WebGL2.
  const FS_EASU = `#version 300 es
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// FidelityFX FSR v1.0.2 by AMD
// Reference https://github.com/GPUOpen-Effects/FidelityFX-FSR/tree/master/ffx-fsr

precision highp float;

uniform sampler2D inputTexture; // 纹理
// uniform vec2 inputTextureSize; // 输入纹理大小
uniform vec2 outputTextureSize; // 输出纹理大小
uniform float uHdrToneMap; // HDR tone mapping 开关

in vec2 vUv; // 从顶点着色器传过来的纹理坐标
out vec4 fragColor; // 输出颜色

vec3 applyHdrToneMap(vec3 color) {
    if (uHdrToneMap < 0.5) {
        return color;
    }

    const float m1 = 0.1593017578125;
    const float m2 = 78.84375;
    const float c1 = 0.8359375;
    const float c2 = 18.8515625;
    const float c3 = 18.6875;

    vec3 powered = pow(max(color, vec3(0.0)), vec3(1.0 / m2));
    vec3 numerator = max(powered - vec3(c1), vec3(0.0));
    vec3 denominator = max(vec3(c2) - vec3(c3) * powered, vec3(1e-6));

    vec3 linearHdr2020 = pow(numerator / denominator, vec3(1.0 / m1)) * 10000.0;
    vec3 linearHdr709 = max(vec3(
        dot(linearHdr2020, vec3(1.6605, -0.5876, -0.0728)),
        dot(linearHdr2020, vec3(-0.1246, 1.1329, -0.0083)),
        dot(linearHdr2020, vec3(-0.0182, -0.1006, 1.1187))
    ), vec3(0.0));
    vec3 linearScene = linearHdr709 / 203.0;
    vec3 linearSdr = linearScene / (vec3(1.0) + linearScene);
    linearSdr = mix(linearSdr, sqrt(max(linearSdr, vec3(0.0))), 0.10);
    linearSdr = clamp(linearSdr, 0.0, 1.0);

    vec3 lower = linearSdr * 12.92;
    vec3 higher = 1.055 * pow(max(linearSdr, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    vec3 cutoff = step(vec3(0.0031308), linearSdr);
    return mix(lower, higher, cutoff);
}

vec3 sampleInput(vec2 uv) {
    return applyHdrToneMap(texture(inputTexture, uv).rgb);
}

//==============================================================================================================================
//
//                                        FSR - [EASU] EDGE ADAPTIVE SPATIAL UPSAMPLING
//
//------------------------------------------------------------------------------------------------------------------------------
// EASU provides a high quality spatial-only scaling at relatively low cost.
// Meaning EASU is appropiate for laptops and other low-end GPUs.
// Quality from 1x to 4x area scaling is good.
//------------------------------------------------------------------------------------------------------------------------------
// The scalar uses a modified fast approximation to the standard lanczos(size=2) kernel.
// EASU runs in a single pass, so it applies a directionally and anisotropically adaptive radial lanczos.
// This is also kept as simple as possible to have minimum runtime.
//------------------------------------------------------------------------------------------------------------------------------
// The lanzcos filter has negative lobes, so by itself it will introduce ringing.
// To remove all ringing, the algorithm uses the nearest 2x2 input texels as a neighborhood,
// and limits output to the minimum and maximum of that neighborhood.
//------------------------------------------------------------------------------------------------------------------------------
// Input image requirements:
// 
// Color needs to be encoded as 3 channel[red, green, blue](e.g.XYZ not supported)
// Each channel needs to be in the range[0, 1]
// Any color primaries are supported
// Display / tonemapping curve needs to be as if presenting to sRGB display or similar(e.g.Gamma 2.0)
// There should be no banding in the input
// There should be no high amplitude noise in the input
// There should be no noise in the input that is not at input pixel granularity
// For performance purposes, use 32bpp formats
//------------------------------------------------------------------------------------------------------------------------------
// Best to apply EASU at the end of the frame after tonemapping 
// but before film grain or composite of the UI.
//------------------------------------------------------------------------------------------------------------------------------

float APrxLoRcpF1(float a) {
    return uintBitsToFloat(uint(0x7ef07ebb) - floatBitsToUint(a));
}

float APrxLoRsqF1(float a) {
    return uintBitsToFloat(uint(0x5f347d74) - (floatBitsToUint(a) >> uint(1)));
}

vec3 AMin3F3(vec3 x, vec3 y, vec3 z) {
    return min(x, min(y, z));
}

vec3 AMax3F3(vec3 x, vec3 y, vec3 z) {
    return max(x, max(y, z));
}

// 计算并设置 EASU 算法需要的常量
void FsrEasuCon(
    out vec4 con0, out vec4 con1, out vec4 con2, out vec4 con3,
    // This the rendered image resolution being upscaled
    float inputViewportInPixelsX, float inputViewportInPixelsY,
    // This is the resolution of the resource containing the input image (useful for dynamic resolution)
    float inputSizeInPixelsX, float inputSizeInPixelsY,
    // This is the display resolution which the input image gets upscaled to
    float outputSizeInPixelsX, float outputSizeInPixelsY
) {
    con0 = vec4(
      inputViewportInPixelsX / outputSizeInPixelsX,
      inputViewportInPixelsY / outputSizeInPixelsY,
      0.5 * inputViewportInPixelsX / outputSizeInPixelsX - 0.5,
      0.5 * inputViewportInPixelsY / outputSizeInPixelsY - 0.5
    );

    con1 = vec4(
      1.0 / inputSizeInPixelsX,
      1.0 / inputSizeInPixelsY,
      1.0 / inputSizeInPixelsX,
      -1.0 / inputSizeInPixelsY
    );

    con2 = vec4(
      -1.0 / inputSizeInPixelsX,
      2.0 / inputSizeInPixelsY,
      1.0 / inputSizeInPixelsX,
      2.0 / inputSizeInPixelsY
    );

    con3 = vec4(
      0.0 / inputSizeInPixelsX,
      4.0 / inputSizeInPixelsY,
      0.0, 
      0.0
    );
}

void FsrEasuConOffset(
    out vec4 con0, out vec4 con1, out vec4 con2, out vec4 con3,
    float inputViewportInPixelsX, float inputViewportInPixelsY,
    float inputSizeInPixelsX, float inputSizeInPixelsY,
    float outputSizeInPixelsX, float outputSizeInPixelsY,
    // This is the input image offset into the resource containing it (useful for dynamic resolution)
    float inputOffsetInPixelsX, float inputOffsetInPixelsY
) {
    FsrEasuCon(con0, con1, con2, con3, inputViewportInPixelsX, inputViewportInPixelsY, inputSizeInPixelsX, inputSizeInPixelsY, outputSizeInPixelsX, outputSizeInPixelsY);
    con0.z = 0.5 * inputViewportInPixelsX / outputSizeInPixelsX - 0.5 + inputOffsetInPixelsX;
    con0.w = 0.5 * inputViewportInPixelsY / outputSizeInPixelsY - 0.5 + inputOffsetInPixelsY;
}

void FsrEasuTapF(
    inout vec3 aC, // Accumulated color, with negative lobe.
    inout float aW, // Accumulated weight.
    vec2 off, // Pixel offset from resolve position to tap.
    vec2 dir, // Gradient direction.
    vec2 len, // Length.
    float lob, // Negative lobe strength.
    float clp, // Clipping point.
    vec3 c // Tap color.
) {
    // Rotate offset by direction.
    vec2 v;
    v.x = (off.x * ( dir.x)) + (off.y * dir.y);
    v.y = (off.x * (-dir.y)) + (off.y * dir.x);
    // Anisotropy.
    v *= len;
    // Compute distance^2.
    float d2 = v.x * v.x + v.y * v.y;
    // Limit to the window as at corner, 2 taps can easily be outside.
    d2 = min(d2, clp);
    // Approximation of lancos2 without sin() or rcp(), or sqrt() to get x.
    //  (25/16 * (2/5 * x^2 - 1)^2 - (25/16 - 1)) * (1/4 * x^2 - 1)^2
    //  |_______________________________________|   |_______________|
    //                   base                             window
    // The general form of the 'base' is,
    //  (a*(b*x^2-1)^2-(a-1))
    // Where 'a=1/(2*b-b^2)' and 'b' moves around the negative lobe.
    float wB = float(2.0 / 5.0) * d2 + -1.0;
    float wA = lob * d2 + -1.0;
    wB *= wB;
    wA *= wA;
    wB = float(25.0 / 16.0) * wB + float(-(25.0 / 16.0 - 1.0));
    float w = wB * wA;
    // Do weighted average.
    aC += c * w;
    aW += w;
}

 void FsrEasuSetF(
    inout vec2 dir,
    inout float len,
    vec2 pp,
    bool biS, bool biT, bool biU, bool biV,
    float lA, float lB, float lC, float lD, float lE
 ) {
    // Compute bilinear weight, branches factor out as predicates are compiler time immediates.
    //  s t
    //  u v
    float w = 0.0;
    if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
    if (biT) w =        pp.x  * (1.0 - pp.y);
    if (biU) w = (1.0 - pp.x) *        pp.y;
    if (biV) w =        pp.x  *        pp.y;
    // Direction is the '+' diff.
    //    a
    //  b c d
    //    e
    // Then takes magnitude from abs average of both sides of 'c'.
    // Length converts gradient reversal to 0, smoothly to non-reversal at 1, shaped, then adding horz and vert terms.
    float dc = lD - lC;
    float cb = lC- lB;
    float lenX = max(abs(dc), abs(cb));
    lenX = APrxLoRcpF1(lenX);
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = clamp(abs(dirX)*lenX, 0.0, 1.0);
    lenX *= lenX;
    len += lenX * w;
    // Repeat for the y axis.
    float ec = lE - lC;
    float ca= lC - lA;
    float lenY = max(abs(ec), abs(ca));
    lenY = APrxLoRcpF1(lenY);
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
    lenY *= lenY;
    len += lenY * w;
}

void FsrEasuF(
    out vec3 pix, // Output values.
    vec2 ip, // Pixel position in output.
    vec4 con0, vec4 con1, vec4 con2, vec4 con3, // Constants generated by FsrEasuCon().
    sampler2D tex
) {
    // Get position of 'f'.
    vec2 pp = ip * con0.xy + con0.zw;
    vec2 fp = floor(pp);
    pp -= fp;

    // 12-tap kernel.
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    // Gather 4 ordering.
    //  a b
    //  r g
    // For packed FP16, need either {rg} or {ab} so using the following setup for gather in all versions,
    //    a b    <- unused (z)
    //    r g
    //  a b a b
    //  r g r g
    //    a b
    //    r g    <- unused (z)
    // Allowing dead-code removal to remove the 'z's.

    //      +---+---+
    //      |   |   |
    //      +--(0)--+
    //      | b | c |
    //  +---F---+---+---+
    //  | e | f | g | h |
    //  +--(1)--+--(2)--+
    //  | i | j | k | l |
    //  +---+---+---+---+
    //      | n | o |
    //      +--(3)--+
    //      |   |   |
    //      +---+---+

    vec3 b = sampleInput((fp + vec2( 0.5, -0.5)) * con1.xy);
    vec3 c = sampleInput((fp + vec2( 1.5, -0.5)) * con1.xy);
    vec3 e = sampleInput((fp + vec2(-0.5,  0.5)) * con1.xy);
    vec3 f = sampleInput((fp + vec2( 0.5,  0.5)) * con1.xy);
    vec3 g = sampleInput((fp + vec2( 1.5,  0.5)) * con1.xy);
    vec3 h = sampleInput((fp + vec2( 2.5,  0.5)) * con1.xy);
    vec3 i = sampleInput((fp + vec2(-0.5,  1.5)) * con1.xy);
    vec3 j = sampleInput((fp + vec2( 0.5,  1.5)) * con1.xy);
    vec3 k = sampleInput((fp + vec2( 1.5,  1.5)) * con1.xy);
    vec3 l = sampleInput((fp + vec2( 2.5,  1.5)) * con1.xy);
    vec3 n = sampleInput((fp + vec2( 0.5,  2.5)) * con1.xy);
    vec3 o = sampleInput((fp + vec2( 1.5,  2.5)) * con1.xy);

    // vec3 b = texture(tex, vUv + vec2( 0.5, -0.5) * con1.xy).rgb;
    // vec3 c = texture(tex, vUv + vec2( 1.5, -0.5) * con1.xy).rgb;
    // vec3 e = texture(tex, vUv + vec2(-0.5,  0.5) * con1.xy).rgb;
    // vec3 f = texture(tex, vUv + vec2( 0.5,  0.5) * con1.xy).rgb;
    // vec3 g = texture(tex, vUv + vec2( 1.5,  0.5) * con1.xy).rgb;
    // vec3 h = texture(tex, vUv + vec2( 2.5,  0.5) * con1.xy).rgb;
    // vec3 i = texture(tex, vUv + vec2(-0.5,  1.5) * con1.xy).rgb;
    // vec3 j = texture(tex, vUv + vec2( 0.5,  1.5) * con1.xy).rgb;
    // vec3 k = texture(tex, vUv + vec2( 1.5,  1.5) * con1.xy).rgb;
    // vec3 l = texture(tex, vUv + vec2( 2.5,  1.5) * con1.xy).rgb;
    // vec3 n = texture(tex, vUv + vec2( 0.5,  2.5) * con1.xy).rgb;
    // vec3 o = texture(tex, vUv + vec2( 1.5,  2.5) * con1.xy).rgb;


    vec4 bczzR = vec4(b.r, c.r, 0.0, 0.0);
    vec4 bczzG = vec4(b.g, c.g, 0.0, 0.0);
    vec4 bczzB = vec4(b.b, c.b, 0.0, 0.0);
    vec4 ijfeR = vec4(i.r, j.r, f.r, e.r);
    vec4 ijfeG = vec4(i.g, j.g, f.g, e.g);
    vec4 ijfeB = vec4(i.b, j.b, f.b, e.b);
    vec4 klhgR = vec4(k.r, l.r, h.r, g.r);
    vec4 klhgG = vec4(k.g, l.g, h.g, g.g);
    vec4 klhgB = vec4(k.b, l.b, h.b, g.b);
    vec4 zzonR = vec4(0.0, 0.0, o.r, n.r);
    vec4 zzonG = vec4(0.0, 0.0, o.g, n.g);
    vec4 zzonB = vec4(0.0, 0.0, o.b, n.b);

    // Simplest multi-channel approximate luma possible (luma times 2, in 2 FMA/MAD).
    vec4 bczzL = bczzB * 0.5 + bczzG * 0.5 + bczzR;
    vec4 ijfeL = ijfeB * 0.5 + ijfeG * 0.5 + ijfeR ;
    vec4 klhgL = klhgB * 0.5 + klhgG * 0.5 + klhgR;
    vec4 zzonL = zzonB * 0.5 + zzonG * 0.5 + zzonR;

    // Rename.
    float bL = bczzL.x;
    float cL = bczzL.y;
    float iL = ijfeL.x;
    float jL = ijfeL.y;
    float fL = ijfeL.z;
    float eL = ijfeL.w;
    float kL = klhgL.x;
    float lL = klhgL.y;
    float hL = klhgL.z;
    float gL = klhgL.w;
    float oL = zzonL.z;
    float nL = zzonL.w;

    // Accumulate for bilinear interpolation.
    vec2 dir = vec2(0.0);
    float len = 0.0;
    FsrEasuSetF(dir, len, pp, true , false, false, false, bL, eL, fL, gL, jL);
    FsrEasuSetF(dir, len, pp, false, true , false, false, cL, fL, gL, hL, kL);
    FsrEasuSetF(dir, len, pp, false, false, true , false, fL, iL, jL, kL, nL);
    FsrEasuSetF(dir, len, pp, false, false, false, true , gL, jL, kL, lL, oL);

    // Normalize with approximation, and cleanup close to zero.
    vec2 dir2 = dir*dir;
    float dirR = dir2.x + dir2.y;
    bool zro = dirR < float(1.0 / 32768.0);
    dirR = APrxLoRsqF1(dirR);
    dirR = zro? 1.0 : dirR;
    dir.x = zro? 1.0 : dir.x;
    dir *= vec2(dirR);
    // Transform from {0 to 2} to {0 to 1} range, and shape with square.
    len = len * 0.5;
    len *= len;
    // Stretch kernel {1.0 vert|horz, to sqrt(2.0) on diagonal}.
    float stretch = (dir.x * dir.x + dir.y * dir.y) * APrxLoRcpF1(max(abs(dir.x), abs(dir.y)));
    // Anisotropic length after rotation,
    //  x := 1.0 lerp to 'stretch' on edges
    //  y := 1.0 lerp to 2x on edges
    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 + -0.5 * len);
    // Based on the amount of 'edge',
    // the window shifts from +/-{sqrt(2.0) to slightly beyond 2.0}.
    float lob= 0.5 + float((1.0 / 4.0 - 0.04) - 0.5) * len;
    // Set distance^2 clipping point to the end of the adjustable window.
    float clp = APrxLoRcpF1(lob);

    // Accumulation
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    vec3 min4 = min(AMin3F3(
        vec3(ijfeR.z, ijfeG.z, ijfeB.z),
        vec3(klhgR.w, klhgG.w, klhgB.w),
        vec3(ijfeR.y, ijfeG.y, ijfeB.y)),
        vec3(klhgR.x, klhgG.x, klhgB.x)
    );
    vec3 max4 = max(AMax3F3(
        vec3(ijfeR.z, ijfeG.z, ijfeB.z),
        vec3(klhgR.w, klhgG.w, klhgB.w),
        vec3(ijfeR.y, ijfeG.y, ijfeB.y)),
        vec3(klhgR.x,klhgG.x,klhgB.x)
    );
    vec3 aC = vec3(0.0);
    float aW = 0.0;
    FsrEasuTapF(aC, aW, vec2( 0.0,-1.0) - pp, dir, len2, lob, clp, vec3(bczzR.x,bczzG.x,bczzB.x)); // b
    FsrEasuTapF(aC, aW, vec2( 1.0,-1.0) - pp, dir, len2, lob, clp, vec3(bczzR.y,bczzG.y,bczzB.y)); // c
    FsrEasuTapF(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, vec3(ijfeR.x,ijfeG.x,ijfeB.x)); // i
    FsrEasuTapF(aC, aW, vec2( 0.0, 1.0) - pp, dir, len2, lob, clp, vec3(ijfeR.y,ijfeG.y,ijfeB.y)); // j
    FsrEasuTapF(aC, aW, vec2( 0.0, 0.0) - pp, dir, len2, lob, clp, vec3(ijfeR.z,ijfeG.z,ijfeB.z)); // f
    FsrEasuTapF(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, vec3(ijfeR.w,ijfeG.w,ijfeB.w)); // e
    FsrEasuTapF(aC, aW, vec2( 1.0, 1.0) - pp, dir, len2, lob, clp, vec3(klhgR.x,klhgG.x,klhgB.x)); // k
    FsrEasuTapF(aC, aW, vec2( 2.0, 1.0) - pp, dir, len2, lob, clp, vec3(klhgR.y,klhgG.y,klhgB.y)); // l
    FsrEasuTapF(aC, aW, vec2( 2.0, 0.0) - pp, dir, len2, lob, clp, vec3(klhgR.z,klhgG.z,klhgB.z)); // h
    FsrEasuTapF(aC, aW, vec2( 1.0, 0.0) - pp, dir, len2, lob, clp, vec3(klhgR.w,klhgG.w,klhgB.w)); // g
    FsrEasuTapF(aC, aW, vec2( 1.0, 2.0) - pp, dir, len2, lob, clp, vec3(zzonR.z,zzonG.z,zzonB.z)); // o
    FsrEasuTapF(aC, aW, vec2( 0.0, 2.0) - pp, dir, len2, lob, clp, vec3(zzonR.w,zzonG.w,zzonB.w)); // n

    // Normalize and dering.
    pix = min(
        max4, 
        max(min4, aC * vec3((1.0 / aW)))
    );
}

void main() {
    vec2 texSize = vec2(textureSize(inputTexture, 0));
    vec4 con0, con1, con2, con3;
    FsrEasuCon(con0, con1, con2, con3,
                texSize.x, texSize.y,
                texSize.x, texSize.y,
                outputTextureSize.x, outputTextureSize.y);
    vec3 pix;
    vec2 ip = floor(vUv * outputTextureSize);
    FsrEasuF(pix, ip, con0, con1, con2, con3, inputTexture);
    fragColor = vec4(pix, 1.0);
}
`;

  const FS_RCAS = `#version 300 es
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// FidelityFX FSR v1.0.2 by AMD
precision highp float;

uniform sampler2D inputTexture; // 纹理采样器
uniform float sharpness; // 锐化强度

in vec2 vUv; // 从顶点着色器传过来的纹理坐标
out vec4 fragColor; // 输出颜色

//_____________________________________________________________/\_______________________________________________________________
//==============================================================================================================================
//
//                                      FSR - [RCAS] ROBUST CONTRAST ADAPTIVE SHARPENING
//
//------------------------------------------------------------------------------------------------------------------------------
// CAS uses a simplified mechanism to convert local contrast into a variable amount of sharpness.
// RCAS uses a more exact mechanism, solving for the maximum local sharpness possible before clipping.
// RCAS also has a built in process to limit sharpening of what it detects as possible noise.
// RCAS sharper does not support scaling, as it should be applied after EASU scaling.
// Pass EASU output straight into RCAS, no color conversions necessary.
//------------------------------------------------------------------------------------------------------------------------------
// RCAS is based on the following logic.
// RCAS uses a 5 tap filter in a cross pattern (same as CAS),
//    w                n
//  w 1 w  for taps  w m e 
//    w                s
// Where 'w' is the negative lobe weight.
//  output = (w*(n+e+w+s)+m)/(4*w+1)
// RCAS solves for 'w' by seeing where the signal might clip out of the {0 to 1} input range,
//  0 == (w*(n+e+w+s)+m)/(4*w+1) -> w = -m/(n+e+w+s)
//  1 == (w*(n+e+w+s)+m)/(4*w+1) -> w = (1-m)/(n+e+w+s-4*1)
// Then chooses the 'w' which results in no clipping, limits 'w', and multiplies by the 'sharp' amount.
// This solution above has issues with MSAA input as the steps along the gradient cause edge detection issues.
// So RCAS uses 4x the maximum and 4x the minimum (depending on equation)in place of the individual taps.
// As well as switching from 'm' to either the minimum or maximum (depending on side), to help in energy conservation.
// This stabilizes RCAS.
// RCAS does a simple highpass which is normalized against the local contrast then shaped,
//       0.25
//  0.25  -1  0.25
//       0.25
// This is used as a noise detection filter, to reduce the effect of RCAS on grain, and focus on real edges.
//
//  GLSL example for the required callbacks :
// 
//  AH4 FsrRcasLoadH(ASW2 p){return AH4(imageLoad(imgSrc,ASU2(p)));}
//  void FsrRcasInputH(inout AH1 r,inout AH1 g,inout AH1 b)
//  {
//    //do any simple input color conversions here or leave empty if none needed
//  }
//  
//  FsrRcasCon need to be called from the CPU or GPU to set up constants.
//  Including a GPU example here, the 'con' value would be stored out to a constant buffer.
// 
//  AU4 con;
//  FsrRcasCon(con,
//   0.0); // The scale is {0.0 := maximum sharpness, to N>0, where N is the number of stops (halving) of the reduction of sharpness}.
// ---------------
// RCAS sharpening supports a CAS-like pass-through alpha via,
//  #define FSR_RCAS_PASSTHROUGH_ALPHA 1
// RCAS also supports a define to enable a more expensive path to avoid some sharpening of noise.
// Would suggest it is better to apply film grain after RCAS sharpening (and after scaling) instead of using this define,
//  #define FSR_RCAS_DENOISE 1
//==============================================================================================================================
// This is set at the limit of providing unnatural results for sharpening.

float APrxMedRcpF1(float a) {
	float b = uintBitsToFloat(uint(0x7ef19fff) - floatBitsToUint(a));
	return b * (-b * a + 2.0);
}

// float APrxLoRcpF1(float a) {
// 	return uintBitsToFloat(uint(0x7ef07ebb) - floatBitsToUint(a));
// }

// float APrxLoRsqF1(float a) {
//     return uintBitsToFloat(uint(0x5f347d74) - (floatBitsToUint(a) >> uint(1)));
// }

float AMin3F1(float x, float y, float z) {
	return min(x, min(y, z));
}

float AMax3F1(float x, float y, float z) {
	return max(x, max(y, z));
}

#define FSR_RCAS_LIMIT (0.25-(1.0/16.0))

// RCAS 算法锐化常量
void FsrRcasCon(
    out vec4 con, // RCAS 算法常量
    float sharpness // 该尺度为{0.0表示最大值，至N>0，其中N为锐度降低（减半）的停止次数}
) {
    // Transform from stops to linear value.
    float linearSharpness = exp2(-sharpness);
    // vec2 hSharp = vec2(sharpness, sharpness); // 16-bit半精度用的，这里用不到
    con = vec4(
        linearSharpness, 
        0.0, // uintBitsToFloat(packHalf2x16(hSharp)),
        0.0, 
        0.0
    );
}

// RCAS 算法
void FsrRcasF(
    out vec3 pix, // 输出像素颜色(RGB)
    vec2 ip, // 输出像素的位置.
    vec4 con, // RCAS 算法常量, 由 FsrRcasCon 函数计算得到.
    sampler2D tex // 输入纹理
) {
    // Algorithm uses minimal 3x3 pixel neighborhood.
    //    b 
    //  d e f
    //    h
    vec2 sp = ip;
    vec3 b = texelFetch(tex, ivec2(sp) + ivec2( 0,-1), 0).rgb;
    vec3 d = texelFetch(tex, ivec2(sp) + ivec2(-1, 0), 0).rgb;
    vec3 e = texelFetch(tex, ivec2(sp)               , 0).rgb;
    vec3 f = texelFetch(tex, ivec2(sp) + ivec2( 1, 0), 0).rgb;
    vec3 h = texelFetch(tex, ivec2(sp) + ivec2( 0, 1), 0).rgb;

    // Rename (32-bit) or regroup (16-bit).
    float bR = b.r;
    float bG = b.g;
    float bB = b.b;
    float dR = d.r;
    float dG = d.g;
    float dB = d.b;
    float eR = e.r;
    float eG = e.g;
    float eB = e.b;
    float fR = f.r;
    float fG = f.g;
    float fB = f.b;
    float hR = h.r;
    float hG = h.g;
    float hB = h.b;

    // Run optional input transform.
    // FsrRcasInputF(bR,bG,bB);
    // FsrRcasInputF(dR,dG,dB);
    // FsrRcasInputF(eR,eG,eB);
    // FsrRcasInputF(fR,fG,fB);
    // FsrRcasInputF(hR,hG,hB);

    // Luma times 2.
    float bL = bB * 0.5 + (bR * 0.5 + bG);
    float dL = dB * 0.5 + (dR * 0.5 + dG);
    float eL = eB * 0.5 + (eR * 0.5 + eG);
    float fL = fB * 0.5 + (fR * 0.5 + fG);
    float hL = hB * 0.5 + (hR * 0.5 + hG);

    // Noise detection.
    float nz = 0.25 * bL + 0.25 * dL + 0.25 * fL + 0.25 * hL - eL;
    nz = clamp(abs(nz) * APrxMedRcpF1(AMax3F1(AMax3F1(bL , dL, eL), fL, hL) - AMin3F1(AMin3F1(bL, dL, eL), fL, hL)), 0.0, 1.0);
    nz = -0.5 * nz + 1.0;

    // Min and max of ring.
    float mn4R = min(AMin3F1(bR, dR, fR), hR);
    float mn4G = min(AMin3F1(bG, dG, fG), hG);
    float mn4B = min(AMin3F1(bB, dB, fB), hB);
    float mx4R = max(AMax3F1(bR, dR, fR), hR);
    float mx4G = max(AMax3F1(bG, dG, fG), hG);
    float mx4B = max(AMax3F1(bB, dB, fB), hB);

    // Immediate constants for peak range.
    vec2 peakC = vec2(1.0, -1.0 * 4.0);

    // Limiters, these need to be high precision RCPs.
    float hitMinR = min(mn4R, eR) / (4.0 * mx4R);
    float hitMinG = min(mn4G, eG) / (4.0 * mx4G);
    float hitMinB = min(mn4B, eB) / (4.0 * mx4B);
    float hitMaxR = (peakC.x - max(mx4R, eR)) / (4.0 * mn4R+peakC.y);
    float hitMaxG = (peakC.x - max(mx4G, eG)) / (4.0 * mn4G+peakC.y);
    float hitMaxB = (peakC.x - max(mx4B, eB)) / (4.0 * mn4B+peakC.y);
    float lobeR = max(-hitMinR, hitMaxR);
    float lobeG = max(-hitMinG, hitMaxG);
    float lobeB = max(-hitMinB, hitMaxB);
    float lobe = max(-FSR_RCAS_LIMIT, min(AMax3F1(lobeR, lobeG, lobeB), 0.0)) * con.x;
    
    // Apply noise removal.
    #ifdef FSR_RCAS_DENOISE
    lobe *= nz;
    #endif
    // Resolve, which needs the medium precision rcp approximation to avoid visible tonality changes.
    float rcpL = APrxMedRcpF1(4.0 * lobe +1.0);
    float pixR = (lobe * bR + lobe * dR + lobe * hR + lobe * fR + eR) * rcpL;
    float pixG = (lobe * bG + lobe * dG + lobe * hG + lobe * fG + eG) * rcpL;
    float pixB = (lobe * bB + lobe * dB + lobe * hB + lobe * fB + eB) * rcpL;
    pix = vec3(pixR, pixG, pixB);
}

void main() {
    vec2 texSize = vec2(textureSize(inputTexture, 0));
    vec2 ip = vUv.xy * texSize;
    vec3 pix;
    vec4 con;
    FsrRcasCon(con, sharpness);
    FsrRcasF(pix, ip, con, inputTexture);
    fragColor = vec4(pix, 1.0);
}`;

  // motion-compensated interpolation between A(prev) and B(cur)
  const FS_COMPOSE = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform sampler2D uFlow;
  uniform float uAlpha;  // 0 = A, 1 = B
  uniform float uMC;     // 1 = motion compensated, 0 = plain blend
  uniform float uWarpOnly; // 1 = output only warped A (diagnostic)
  float inb(vec2 uv) {
    vec2 d = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    return d.x * d.y;
  }
  void main() {
    vec2 f = texture(uFlow, vUv).xy * uMC;
    vec2 uvA = vUv - f * uAlpha;
    vec2 uvB = vUv + f * (1.0 - uAlpha);
    vec4 a = texture(uA, uvA);
    vec4 b = texture(uB, uvB);
    float ca = inb(uvA);
    float cb = inb(uvB);
    float w = uAlpha;
    float wsum = (1.0 - w) * ca + w * cb + 1e-5;
    o = (a * (1.0 - w) * ca + b * w * cb) / wsum;
    if (uWarpOnly > 0.5) o = vec4(a.rgb * ca, 1.0);
    o.a = 1.0;
  }`;

  // sharpen + view transform (fit/fill/zoom), black outside
  const FS_SHARP = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc;
  uniform vec2 uTexel;
  uniform float uSharp;
  uniform vec2 uScale;
  uniform vec2 uOffset;
  void main() {
    vec2 uv = vUv * uScale + uOffset;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    vec4 c = texture(uSrc, uv);
    vec4 n = texture(uSrc, uv + vec2(0.0, uTexel.y));
    vec4 s = texture(uSrc, uv - vec2(0.0, uTexel.y));
    vec4 e = texture(uSrc, uv + vec2(uTexel.x, 0.0));
    vec4 w = texture(uSrc, uv - vec2(uTexel.x, 0.0));
    vec4 blur = (n + s + e + w) * 0.25;
    vec4 outc = clamp(c + (c - blur) * (uSharp * 3.0), 0.0, 1.0);
    o = vec4(outc.rgb * inside, 1.0);
  }`;

  // ============================== PostFX ==============================
  class PostFX {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: true, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;
      this.progLuma = this._program(VS, FS_LUMA);
      this.progFlow = this._program(VS, FS_FLOW);
      this.progCompose = this._program(VS, FS_COMPOSE);
      this.progSharp = this._program(VS, FS_SHARP);
      this.progPack = this._program(VS, FS_PACK);
      this.progEasu = this._program(VS, FS_EASU);
      this.progRcas = this._program(VS, FS_RCAS);
      this.vao = gl.createVertexArray();
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.floatRenderable = !!gl.getExtension('EXT_color_buffer_float');
      this.flowEncode = !this.floatRenderable; // RGBA8 fallback packs flow*4+0.5
      this.ring = [];       // full-res frame textures
      this.lumRing = [];    // low-res luma textures
      this.flowRing = [];   // low-res flow textures
      this.tsRing = [];     // presentation timestamps
      this.ringPos = 0;
      this.ringFilled = 0;
      this.flowRes = [96, 54];
      this.fbo = gl.createFramebuffer();
      this.composeTex = null;
      this.lastGpuMs = 0;
    }

    _shader(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src.trim());
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    }
    _program(vs, fs) {
      const gl = this.gl;
      const p = gl.createProgram();
      gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(p));
      }
      return p;
    }

    _mkTex(w, h, float16) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (float16 && this.floatRenderable) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    resize(w, h) {
      const gl = this.gl;
      // NOTE: canvas backing size belongs to layout(); resize() only owns source textures
      for (const t of this.ring) gl.deleteTexture(t);
      for (const t of this.lumRing) gl.deleteTexture(t);
      for (const t of this.flowRing) gl.deleteTexture(t);
      if (this.composeTex) gl.deleteTexture(this.composeTex);
      if (this.fsrTex) gl.deleteTexture(this.fsrTex);
      this.ring = [this._mkTex(w, h), this._mkTex(w, h), this._mkTex(w, h)];
      const [fw, fh] = this.flowRes;
      this.lumRing = [this._mkTex(fw, fh), this._mkTex(fw, fh), this._mkTex(fw, fh)];
      this.flowRing = [this._mkTex(fw, fh, true), this._mkTex(fw, fh, true), this._mkTex(fw, fh, true)];
      // intermediates are OUTPUT-res: allocated/realigned in _ensureIntermediates()
      this.composeTex = null;
      this.fsrTex = null;
      this.composeTexSize = [0, 0];
      this.ringPos = 0;
      this.ringFilled = 0;
      this.tsRing = [0, 0, 0];
      this.srcSize = [w, h];
    }

    _draw() {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // upload a source frame (video/canvas), compute luma + flow, advance ring
    pushFrame(src, ts) {
      const gl = this.gl;
      const i = this.ringPos;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, this.ring[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.tsRing[i] = ts;

      // luma downsample of new frame
      gl.useProgram(this.progLuma);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lumRing[i], 0);
      gl.viewport(0, 0, this.flowRes[0], this.flowRes[1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ring[i]);
      gl.uniform1i(gl.getUniformLocation(this.progLuma, 'uSrc'), 0);
      gl.uniform2f(gl.getUniformLocation(this.progLuma, 'uStep'), 2 / this.srcSize[0], 2 / this.srcSize[1]);
      this._draw();

      // flow prev -> new (only if we have a previous frame)
      const prev = (this.ringFilled === 0 && this.ringPos === 0) ? -1 : (this.ringPos + 2) % 3;
      if (prev >= 0 && this.tsRing[prev] > 0) {
        gl.useProgram(this.progFlow);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.flowRing[i], 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.lumRing[prev]);
        gl.uniform1i(gl.getUniformLocation(this.progFlow, 'uPrev'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lumRing[i]);
        gl.uniform1i(gl.getUniformLocation(this.progFlow, 'uCur'), 1);
        gl.uniform2f(gl.getUniformLocation(this.progFlow, 'uTexel'), 1 / this.flowRes[0], 1 / this.flowRes[1]);
        this._draw();
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.ringPos = (this.ringPos + 1) % 3;
      this.ringFilled = Math.min(this.ringFilled + 1, 3);
    }

    // latest two frames: returns {aIdx, bIdx, tsA, tsB} or null
    _pair() {
      if (this.ringFilled < 2) return null;
      const bIdx = (this.ringPos + 2) % 3;
      const aIdx = (this.ringPos + 1) % 3;
      return { aIdx, bIdx, tsA: this.tsRing[aIdx], tsB: this.tsRing[bIdx] };
    }

    _viewTransform() {
      // map output vUv -> source uv for fit/fill/zoom
      const sw = this.srcSize[0], sh = this.srcSize[1];
      const cw = this.canvas.width, ch = this.canvas.height;
      const srcAR = sw / sh, dstAR = cw / ch;
      const s = this._cropScale(srcAR, dstAR);
      return { scale: s, offset: [(1 - s[0]) / 2, (1 - s[1]) / 2] };
    }
    _cropScale(srcAR, dstAR) {
      if (cfg.viewMode === 'fit') {
        return srcAR > dstAR ? [1, dstAR / srcAR] : [srcAR / dstAR, 1];
      }
      if (cfg.viewMode === 'zoom') {
        const base = srcAR > dstAR ? [dstAR / srcAR, 1] : [1, srcAR / dstAR];
        return [base[0] / 1.25, base[1] / 1.25];
      }
      // fill = cover
      return srcAR > dstAR ? [dstAR / srcAR, 1] : [1, srcAR / dstAR];
    }

    // intermediates must match the OUTPUT (canvas backing) size, not the source size
    _ensureIntermediates() {
      const gl = this.gl;
      const w = this.canvas.width, h = this.canvas.height;
      if (w < 2 || h < 2) return;
      if (this.composeTexSize[0] === w && this.composeTexSize[1] === h) return;
      if (this.composeTex) gl.deleteTexture(this.composeTex);
      if (this.fsrTex) gl.deleteTexture(this.fsrTex);
      this.composeTex = this._mkTex(w, h);
      this.fsrTex = this._mkTex(w, h);
      this.composeTexSize = [w, h];
    }

    // render to canvas; alpha in [0,1] for framegen pair, or 'latest'
    render(opts) {
      const gl = this.gl;
      const t0 = performance.now();
      this._ensureIntermediates();
      const mode = opts.mode || cfg.mode;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      let srcTex;
      if (mode === 'framegen' && opts.pair) {
        const { aIdx, bIdx, alpha } = opts.pair;
        // compose -> composeTex
        gl.useProgram(this.progCompose);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.composeTex, 0);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.ring[aIdx]);
        gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uA'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.ring[bIdx]);
        gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uB'), 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.flowRing[bIdx]);
        gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uFlow'), 2);
        gl.uniform1f(gl.getUniformLocation(this.progCompose, 'uAlpha'), alpha);
        gl.uniform1f(gl.getUniformLocation(this.progCompose, 'uMC'), cfg.framegen === 'mc' ? 1 : 0);
        this._draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        srcTex = this.composeTex;
      } else if (mode === 'upscale' && effectiveScaler() !== 'fsr') {
        // 'rcas': bilinear upsample + contrast-adaptive sharpen in the final pass
        // 'bilinear': plain copy (lowest load)
        const p = this._pair();
        srcTex = this.ring[p ? p.bIdx : this.ringPos];
      } else if (mode === 'upscale') {
        // FSR 1.0: EASU upscale pass -> RCAS sharpen pass -> view-transform copy
        const p = this._pair();
        const frameTex = this.ring[p ? p.bIdx : this.ringPos];
        gl.useProgram(this.progEasu);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fsrTex, 0);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frameTex);
        gl.uniform1i(gl.getUniformLocation(this.progEasu, 'inputTexture'), 0);
        gl.uniform2f(gl.getUniformLocation(this.progEasu, 'outputTextureSize'), this.canvas.width, this.canvas.height);
        gl.uniform1f(gl.getUniformLocation(this.progEasu, 'uHdrToneMap'), 0);
        this._draw();
        gl.useProgram(this.progRcas);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.composeTex, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.fsrTex);
        gl.uniform1i(gl.getUniformLocation(this.progRcas, 'inputTexture'), 0);
        gl.uniform1f(gl.getUniformLocation(this.progRcas, 'sharpness'), Math.max(0.05, cfg.sharpness));
        this._draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        srcTex = this.composeTex;
      } else {
        const p = this._pair();
        srcTex = this.ring[p ? p.bIdx : this.ringPos];
      }

      // sharpen + view transform -> screen
      const vt = this._viewTransform();
      gl.useProgram(this.progSharp);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(gl.getUniformLocation(this.progSharp, 'uSrc'), 0);
      gl.uniform2f(gl.getUniformLocation(this.progSharp, 'uTexel'), 1 / this.srcSize[0], 1 / this.srcSize[1]);
      const wantsSharp = mode === 'sharp' || mode === 'framegen' ||
        (mode === 'upscale' && effectiveScaler() === 'rcas');
      gl.uniform1f(gl.getUniformLocation(this.progSharp, 'uSharp'), wantsSharp ? cfg.sharpness : 0); // fsr upscale is sharpened by RCAS already
      gl.uniform2f(gl.getUniformLocation(this.progSharp, 'uScale'), vt.scale[0], vt.scale[1]);
      gl.uniform2f(gl.getUniformLocation(this.progSharp, 'uOffset'), vt.offset[0], vt.offset[1]);
      this._draw();
      gl.flush();
      if (opts.sync) gl.finish(); // true GPU timing sample (selftest only)
      const t1 = performance.now();
      this.lastCpuMs = t1 - t0;
      return t1 - t0;
    }

    // mean flow magnitude of the latest pair (diagnostic, via RGBA8 pack pass)
    flowStats() {
      const gl = this.gl;
      const p = this._pair();
      if (!p) return null;
      const [fw, fh] = this.flowRes;
      const tmp = this._mkTex(fw, fh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmp, 0);
      gl.viewport(0, 0, fw, fh);
      gl.useProgram(this.progPack);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.flowRing[p.bIdx]);
      gl.uniform1i(gl.getUniformLocation(this.progPack, 'uSrc'), 0);
      this._draw();
      const b = new Uint8Array(fw * fh * 4);
      gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(tmp);
      let sx = 0, sy = 0;
      for (let i = 0; i < fw * fh; i++) {
        sx += Math.abs((b[i * 4] / 255 - 0.5) * 0.25);
        sy += Math.abs((b[i * 4 + 1] / 255 - 0.5) * 0.25);
      }
      const n = fw * fh;
      const idxs = [Math.floor(fh / 2) * fw + Math.floor(fw / 2), Math.floor(fh / 4) * fw + Math.floor(fw / 4), Math.floor(fh * 3 / 4) * fw + Math.floor(fw * 3 / 4)];
      const samples = idxs.map((i) => [+((b[i * 4] / 255 - 0.5) * 0.25 * fw).toFixed(3), +((b[i * 4 + 1] / 255 - 0.5) * 0.25 * fh).toFixed(3)]);
      return {
        meanFlowTexels: +((sx / n) * fw).toFixed(3),  // x component, in luma texels
        meanFlowVTexels: +((sy / n) * fh).toFixed(3),
        meanFlowSrcPx: +((sx / n) * this.srcSize[0]).toFixed(2), // in source pixels
        samplesTexels: samples, // [x,y] at center + 2 corners, luma texels
      };
    }

    // deterministic compose for testing: given ring a/b and alpha, returns pixels
    debugCompose(alpha, w, h, warpOnly) {
      const gl = this.gl;
      const p = this._pair();
      if (!p) return null;
      const tmp = this._mkTex(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmp, 0);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.progCompose);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ring[p.aIdx]);
      gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uA'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.ring[p.bIdx]);
      gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uB'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.flowRing[p.bIdx]);
      gl.uniform1i(gl.getUniformLocation(this.progCompose, 'uFlow'), 2);
      gl.uniform1f(gl.getUniformLocation(this.progCompose, 'uAlpha'), alpha);
      gl.uniform1f(gl.getUniformLocation(this.progCompose, 'uMC'), cfg.framegen === 'mc' ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(this.progCompose, 'uWarpOnly'), warpOnly ? 1 : 0);
      this._draw();
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(tmp);
      return px;
    }
  }

  // ============================== UI ==============================
  const css = `
  #kujira-canvas { position: fixed; z-index: 2147483000; pointer-events: none; background: #000; }
  #kujira-amb { position: fixed; inset: 0; z-index: 2147482999; pointer-events: none;
    filter: blur(70px) saturate(1.5) brightness(1.15); transform: scale(1.1); }
  #kujira-hud { position: fixed; top: 12px; left: 12px; z-index: 51; pointer-events: none;
    font: 12px/1.5 ui-monospace, Menlo, monospace; color: #9fe8ff; background: rgba(5,12,20,.55);
    padding: 6px 10px; border-radius: 8px; white-space: pre; }
  #kujira-panel { position: fixed; top: 60px; right: 16px; z-index: 50; width: 260px;
    background: rgba(10,18,28,.92); color: #d7e7f3; border: 1px solid rgba(120,180,220,.25);
    border-radius: 12px; padding: 14px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;
    backdrop-filter: blur(12px); }
  #kujira-panel h3 { margin: 0 0 10px; font-size: 14px; color: #6fd3ff; letter-spacing: .5px; }
  #kujira-panel .row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; gap: 8px; }
  #kujira-panel .seg { display: flex; gap: 4px; flex-wrap: wrap; }
  #kujira-panel button { cursor: pointer; border: 1px solid rgba(120,180,220,.3); background: rgba(40,70,100,.35);
    color: #cfe6f5; border-radius: 7px; padding: 3px 9px; font-size: 12px; }
  #kujira-panel button.on { background: #1c6fa8; border-color: #43b0e8; color: #fff; }
  #kujira-panel input[type=range] { width: 110px; accent-color: #43b0e8; }
  #kujira-panel .hint { color: #7a93a8; font-size: 11px; margin-top: 10px; }
  `;

  function boot() {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    // ambilight canvas
    const amb = document.createElement('canvas');
    amb.id = 'kujira-amb';
    amb.width = 96; amb.height = 54;
    document.documentElement.appendChild(amb);

    // stream canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'kujira-canvas';
    document.documentElement.appendChild(canvas);

    const hud = document.createElement('div');
    hud.id = 'kujira-hud';
    document.documentElement.appendChild(hud);

    let fx = null;
    try {
      fx = new PostFX(canvas);
    } catch (e) {
      hud.textContent = '[Kujira] WebGL2 失败: ' + e.message + '（已直通原始视频）';
      return;
    }
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cfg.enabled = false;
      hud.textContent = '[Kujira] GPU 上下文丢失，已切换兼容模式（原始视频直通）';
      log('webgl context lost');
    });

    // ---------- source discovery ----------
    let srcEl = null, srcKind = null;
    function pickSource() {
      if (window.__KUJIRA_TEST_SOURCE__) {
        if (srcEl !== window.__KUJIRA_TEST_SOURCE__) {
          srcEl = window.__KUJIRA_TEST_SOURCE__;
          srcKind = 'test';
          onNewSource();
        }
        return;
      }
      const vids = Array.from(document.querySelectorAll('video'));
      let best = null, bestPx = 0;
      for (const v of vids) {
        const px = (v.videoWidth || 0) * (v.videoHeight || 0);
        if (px > bestPx && v.readyState >= 2) { best = v; bestPx = px; }
      }
      if (best && best !== srcEl) {
        srcEl = best;
        srcKind = 'video';
        onNewSource();
      }
    }
    function onNewSource() {
      const w = srcEl.videoWidth || srcEl.width || 1920;
      const h = srcEl.videoHeight || srcEl.height || 1080;
      fx.resize(w, h);
      frameCount = 0;
      if (srcKind === 'video') {
        srcEl.style.opacity = '0';
        try { srcEl.requestVideoFrameCallback(onVideoFrame); } catch (e) {}
      }
      log('source -> ' + srcKind + ' ' + w + 'x' + h);
    }
    function log(msg) { console.log('[KUJIRA] ' + msg); }

    let frameCount = 0;
    function onVideoFrame(now, meta) {
      if (srcEl && srcEl.readyState >= 2) {
        const ts = meta && meta.presentationTime ? meta.presentationTime : now;
        fx.pushFrame(srcEl, ts);
        frameCount++;
        srcFpsCount++;
        // latency: present fresh frames NOW instead of waiting up to one rAF
        // (interp mode keeps rAF pacing — its timeline must stay monotonic)
        if (cfg.enabled && (cfg.mode === 'sharp' || cfg.mode === 'upscale') && canvas.width > 0) {
          try {
            fx.render({ mode: cfg.mode, sync: false });
            lastPresentedFrame = frameCount;
            srcPassCount++; outFpsCount++;
          } catch (e) {}
        }
      }
      if (srcEl) { try { srcEl.requestVideoFrameCallback(onVideoFrame); } catch (e) {} }
    }

    // ---------- layout ----------
    function layout() {
      if (!srcEl) return;
      let r;
      if (srcKind === 'test') {
        r = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      } else {
        r = srcEl.getBoundingClientRect();
        if (r.width < 64 || r.height < 64) {
          r = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        }
      }
      canvas.style.left = r.left + 'px';
      canvas.style.top = r.top + 'px';
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let cw = Math.round(r.width * dpr), ch = Math.round(r.height * dpr);
      // output resolution tier: scale backing long edge to the chosen tier (SSAA up or down)
      const longEdge = cfg.outputRes === '4K' ? 3840 : cfg.outputRes === '1440p' ? 2560
                     : cfg.outputRes === '1080p' ? 1920 : 0;
      if (longEdge > 0 && cw > 0 && ch > 0) {
        const k = longEdge / Math.max(cw, ch);
        cw = Math.max(2, Math.round(cw * k));
        ch = Math.max(2, Math.round(ch * k));
      }
      if (canvas.width !== cw || canvas.height !== ch) {
        // keep source texture res; only output viewport changes
        canvas.width = cw; canvas.height = ch;
      }
      amb.style.opacity = cfg.ambilight && cfg.enabled ? String(cfg.ambilightIntensity) : '0';
    }

    // ---------- render loop ----------
    let srcFpsCount = 0, outFpsCount = 0, renderMsSum = 0, renderMsN = 0;
    let interpCount = 0, srcPassCount = 0, lastPresentedFrame = -1;
    let rafCount = 0, screenHz = 60, outSeq = -1, lastOutPhase = -1;
    let renderErrs = 0;
    let lastTestPush = 0;
    let lastStatAt = performance.now();
    let stats = { srcFps: 0, outFps: 0, renderMs: 0, gpuMs: 0, latencyMs: 0, mode: cfg.mode };
    window.__KUJIRA_METRICS__ = window.__KUJIRA_METRICS__ || {};

    function tick(now) {
      requestAnimationFrame(tick);
      if (!srcEl || !cfg.enabled || cfg.mode === 'off') {
        canvas.style.display = 'none';
        if (srcEl && srcKind === 'video') srcEl.style.opacity = '1';
        return;
      }
      canvas.style.display = 'block';
      if (srcKind === 'video') srcEl.style.opacity = '0';
      layout();
      rafCount++;
      // output refresh tier: emit at most cfg.outputHz frames per display second
      if (typeof cfg.outputHz === 'number' && cfg.outputHz > 0 && screenHz > 0) {
        outSeq++;
        const phase = Math.floor((outSeq + 1) * cfg.outputHz / screenHz);
        if (phase === lastOutPhase) return;
        lastOutPhase = phase;
      }

      // test/canvas source: push ~60fps worth of frames (skip duplicate display ticks)
      if (srcKind === 'test') {
        if (!lastTestPush || now - lastTestPush >= 15.5) {
          fx.pushFrame(srcEl, now);
          lastTestPush = now;
          frameCount++;
          srcFpsCount++;
        }
      }

      let opts = { mode: cfg.mode, sync: outFpsCount % 60 === 0 };
      if (cfg.mode === 'framegen') {
        const p = fx._pair();
        if (p && p.tsB > p.tsA) {
          const period = p.tsB - p.tsA;
          // latencyBias: 1.0 = smooth 2x pacing (one frame of latency),
          // lower = fresher content with a short hold (e.g. 0.5 = half frame).
          const bias = typeof cfg.latencyBias === 'number' ? Math.min(1, Math.max(0.3, cfg.latencyBias)) : 1;
          const delay = period * bias;
          const tau = now - delay;
          let aIdx = p.aIdx, bIdx = p.bIdx, tsA = p.tsA, tsB = p.tsB, alpha;
          if (tau <= tsA) { alpha = 0; }
          else if (tau >= tsB) { alpha = 1; }
          else { alpha = (tau - tsA) / (tsB - tsA); }
          opts.pair = { aIdx, bIdx, alpha };
          stats.latencyMs = Math.round(delay);
        }
      }
      // non-interp modes: skip re-presenting an unchanged source frame
      // (onVideoFrame already presented it immediately — zero rAF wait)
      const skipDup = srcKind === 'video' && cfg.mode !== 'framegen' && frameCount === lastPresentedFrame;
      let ms;
      if (!skipDup) {
        try {
          ms = fx.render(opts);
        } catch (err) {
          renderErrs++;
          if (renderErrs >= 30) {
            cfg.enabled = false; saveCfg();
            hud.textContent = '[Kujira] 渲染异常，已切换兼容模式（原始视频直通）';
            log('render failover: ' + err);
          }
          return;
        }
        renderErrs = 0;
        lastPresentedFrame = frameCount;
        // framegen truth meter: count genuinely synthesized frames
        if (opts.pair && opts.pair.alpha > 0 && opts.pair.alpha < 1 && opts.pair.aIdx !== opts.pair.bIdx) interpCount++;
        else srcPassCount++;
        renderMsSum += ms; renderMsN++; outFpsCount++;
        if (opts.sync) stats.gpuMs = +ms.toFixed(2); // renderMs with gl.finish() = real GPU time
      }

      // ambilight: cheap low-res copy of the source video
      if (cfg.ambilight && (outFpsCount & 1) === 0) {
        try {
          const actx = amb.getContext('2d');
          actx.drawImage(srcEl, 0, 0, amb.width, amb.height);
        } catch (e) {}
      }

      if (now - lastStatAt >= 1000) {
        const dt = (now - lastStatAt) / 1000;
        screenHz = Math.round(rafCount / dt) || screenHz;
        stats.srcFps = Math.round(srcFpsCount / dt);
        stats.outFps = Math.round(outFpsCount / dt);
        stats.renderMs = renderMsN ? +(renderMsSum / renderMsN).toFixed(2) : 0;
        stats.interpFps = Math.round(interpCount / dt);
        stats.srcPassFps = Math.round(srcPassCount / dt);
        stats.interpGain = stats.outFps - stats.srcFps;
        // self-diagnosis: framegen needs display headroom above the source rate
        stats.noGain = cfg.mode === 'framegen' && screenHz <= Math.max(stats.srcFps, stats.outFps) * 1.1;
        interpCount = 0; srcPassCount = 0;
        const net = window.__KUJIRA_NET__;
        stats.net = (net && Date.now() - net.at < 15000)
          ? net.local + (net.local !== net.remote ? '→' + net.remote : '') + ' rtt' + net.rtt + 'ms'
          : '';
        stats.mode = cfg.mode + (cfg.mode === 'framegen' ? ':' + cfg.framegen : '')
          + (cfg.mode === 'upscale' ? ':' + effectiveScaler() : '')
          + ' [' + GPU.vendor + ']';
        srcFpsCount = 0; outFpsCount = 0; renderMsSum = 0; renderMsN = 0; rafCount = 0;
        lastStatAt = now;
        Object.assign(window.__KUJIRA_METRICS__, stats);
        if (cfg.stats) {
          hud.style.display = 'block';
          hud.textContent =
            `Kujira ${VERSION}  ${stats.mode}\n` +
            `src ${stats.srcFps}fps -> out ${stats.outFps}fps  ${canvas.width}x${canvas.height}@${screenHz}Hz\n` +
            `render ${stats.renderMs}ms  gpu ${stats.gpuMs}ms  latency +${stats.latencyMs}ms\n` +
            (stats.noGain
              ? `\u26a0\u63d2\u5e27\u65e0\u589e\u76ca\uff1a\u663e\u793a ${screenHz}Hz \u2264 \u6e90 ${stats.srcFps}fps\uff08\u9ad8\u5237\u65b0\u4f1a\u8bdd/\u7269\u7406\u5c4f\u4e0b\u751f\u6548\uff09`
              : `interp ${stats.interpFps}/s  gain +${stats.interpGain}/s`) +
            `  src-pass ${stats.srcPassFps}/s` + (stats.net ? '  net ' + stats.net : '');
        } else {
          hud.style.display = 'none';
        }
      }
    }

    // ---------- settings panel ----------
    function buildPanel() {
      const p = document.createElement('div');
      p.id = 'kujira-panel';
      p.innerHTML = `
        <h3>🐋 Kujira ${VERSION}</h3>
        <div class="row"><span>后处理</span><div class="seg" data-k="mode">
          <button data-v="off">关</button><button data-v="sharp">锐化</button>
          <button data-v="upscale">超分</button><button data-v="framegen">插帧</button></div></div>
        <div class="row"><span>插帧算法</span><div class="seg" data-k="framegen">
          <button data-v="mc">运动补偿</button><button data-v="blend">帧混合</button></div></div>
        <div class="row"><span>视图</span><div class="seg" data-k="viewMode">
          <button data-v="fit">适应</button><button data-v="fill">填充</button><button data-v="zoom">放大</button></div></div>
        <div class="row"><span>锐度</span><input type="range" min="0" max="1" step="0.05" data-k="sharpness"></div>
        <div class="row"><span>环境光</span><div class="seg" data-k="ambilight">
          <button data-v="true">开</button><button data-v="false">关</button></div></div>
        <div class="row"><span>光强</span><input type="range" min="0" max="1" step="0.05" data-k="ambilightIntensity"></div>
        <div class="hint">Alt/⌥+K 面板 | Alt/⌥+1/2/3 视图 | Alt/⌥+S 状态 | Alt/⌥+E 开关 | Alt/⌥+P 截图 | Alt/⌥+F 模式</div>
      `;
      document.documentElement.appendChild(p);

      function refresh() {
        p.querySelectorAll('.seg').forEach((seg) => {
          const k = seg.dataset.k;
          seg.querySelectorAll('button').forEach((b) => {
            const v = b.dataset.v;
            const cur = String(cfg[k]);
            b.classList.toggle('on', v === cur);
          });
        });
        p.querySelectorAll('input[type=range]').forEach((inp) => {
          inp.value = String(cfg[inp.dataset.k]);
        });
      }
      p.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const k = b.parentElement.dataset.k;
        let v = b.dataset.v;
        if (v === 'true') v = true;
        if (v === 'false') v = false;
        cfg[k] = v;
        saveCfg();
        refresh();
        applyCfg();
      });
      p.addEventListener('input', (e) => {
        const inp = e.target;
        if (inp.type !== 'range') return;
        cfg[inp.dataset.k] = parseFloat(inp.value);
        saveCfg();
        applyCfg();
      });
      refresh();
      return p;
    }

    function applyCfg() {
      hud.style.display = cfg.stats ? 'block' : 'none';
      hud.style.opacity = String(cfg.hudOpacity != null ? cfg.hudOpacity : 0.85);
      if (panel) panel.style.display = cfg.panel ? 'block' : 'none';
      layout();
    }

    // ---------- screenshot (works even with postfx off) ----------
    function screenshot() {
      try {
        const useFx = cfg.enabled && cfg.mode !== 'off' && canvas.style.display !== 'none';
        const w = useFx ? canvas.width : (srcEl.videoWidth || srcEl.width || 1920);
        const h = useFx ? canvas.height : (srcEl.videoHeight || srcEl.height || 1080);
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const c2 = tmp.getContext('2d');
        c2.drawImage(useFx ? canvas : srcEl, 0, 0, w, h);
        const a = document.createElement('a');
        a.href = tmp.toDataURL('image/png');
        a.download = 'kujira-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        log('screenshot: ' + a.download);
      } catch (err) {
        log('screenshot failed: ' + err);
      }
    }

    const panel = buildPanel();
    cfg.panel = false; // Kujira: never auto-show on boot — open from the stream menu / hotkey

    // ---------- hotkeys ----------
    // Cross-platform hotkeys: match PHYSICAL keys via e.code.
    // e.key is a trap — on macOS Option+K types '˚' and on Windows the bare
    // Alt combo can activate the menu bar, so e.key.toLowerCase() never matches.
    // Accept Alt/Option/Ctrl as the modifier on every OS.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || (!e.altKey && !e.ctrlKey && !e.metaKey)) return;
      const code = e.code;
      const hit = () => { e.preventDefault(); e.stopPropagation(); };
      if (code === 'KeyK') { cfg.panel = !cfg.panel; saveCfg(); applyCfg(); hit(); }
      else if (code === 'KeyS') { cfg.stats = !cfg.stats; saveCfg(); applyCfg(); hit(); }
      else if (code === 'KeyE') { cfg.enabled = !cfg.enabled; saveCfg(); hit(); }
      else if (code === 'Digit1' || code === 'Numpad1') { cfg.viewMode = 'fit'; saveCfg(); applyCfg(); hit(); }
      else if (code === 'Digit2' || code === 'Numpad2') { cfg.viewMode = 'fill'; saveCfg(); applyCfg(); hit(); }
      else if (code === 'Digit3' || code === 'Numpad3') { cfg.viewMode = 'zoom'; saveCfg(); applyCfg(); hit(); }
      else if (code === 'KeyP') { screenshot(); hit(); }
      else if (code === 'KeyF') {
        const order = ['off', 'sharp', 'upscale', 'framegen'];
        cfg.mode = order[(order.indexOf(cfg.mode) + 1) % order.length];
        saveCfg(); applyCfg(); hit();
      }
    });

    setInterval(pickSource, 500);
    pickSource();
    applyCfg();
    requestAnimationFrame(tick);
    log('engine ready v' + VERSION);
    window.__KUJIRA__ = { version: VERSION, fx: () => fx, cfg: () => cfg, setCfg: (k, v) => { cfg[k] = v; saveCfg(); applyCfg(); }, src: () => srcEl, screenshot: () => screenshot() };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
