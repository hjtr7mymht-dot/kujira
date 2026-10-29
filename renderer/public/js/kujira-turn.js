// [Kujira] TURN relay injector — the missing half of Midori's remote-play trick.
//
// xstreaming-player ships STUN only: when hole punching fails (CGNAT / strict NAT)
// the connection dies with "NAT failed". Midori solves this with dynamic TURN
// credentials (turn-creds.midoriapp.app / midori.metered.live = Metered.ca TURN).
// We wrap RTCPeerConnection and merge TURN servers into every ICE config so the
// client always has relay candidates — the console dials out to the TURN server
// and the stream works behind any NAT, no port forwarding needed.
//
// Default: Open Relay (free, no signup). Override via localStorage 'kujira.turn'
// (JSON array of RTCIceServer entries) with your own TURN for better throughput.
(() => {
  'use strict';
  if (window.__KUJIRA_TURN__) return;
  window.__KUJIRA_TURN__ = true;

  const DEFAULT_TURN = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let extra = DEFAULT_TURN;
  try {
    const raw = window.localStorage.getItem('kujira.turn');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) extra = parsed;
    }
  } catch (e) {}

  const Orig = window.RTCPeerConnection;
  if (typeof Orig !== 'function') {
    console.error('[KUJIRA-TURN] no RTCPeerConnection on this page, skip');
    return;
  }

  function KujiraPeerConnection(config, ...rest) {
    try {
      const cfg = Object.assign({}, config || {});
      const own = Array.isArray(cfg.iceServers) ? cfg.iceServers.slice() : [];
      // merge: keep originals first, append relay candidates
      cfg.iceServers = own.concat(extra);
      console.log('[KUJIRA-TURN] ICE config: ' + own.length + ' native + ' + extra.length + ' TURN relay servers');
      const pc = new Orig(cfg, ...rest); kujiraWatchNet(pc); return pc;
    } catch (e) {
      // fail-safe: bad TURN config must NEVER break the stream
      console.error('[KUJIRA-TURN] injected config rejected (' + e.name + '), falling back to native ICE');
      const pc = new Orig(config, ...rest); kujiraWatchNet(pc); return pc;
    }
  }
  KujiraPeerConnection.prototype = Orig.prototype;
  if (Orig.generateCertificate) {
    KujiraPeerConnection.generateCertificate = Orig.generateCertificate.bind(Orig);
  }
  // network visibility: report the selected candidate pair so relay/accelerator
  // paths are observable (window.__KUJIRA_NET__ -> HUD "net" line)
  const kujiraReportNet = async (pc) => {
    try {
      const s = await pc.getStats();
      let pair = null;
      s.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
      if (pair) {
        const lo = s.get(pair.localCandidateId) || {};
        const ro = s.get(pair.remoteCandidateId) || {};
        window.__KUJIRA_NET__ = {
          local: lo.candidateType || '?',
          remote: ro.candidateType || '?',
          rtt: pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : 0,
          at: Date.now(),
        };
      }
    } catch (e) {}
  };
  const kujiraWatchNet = (pc) => {
    const start = () => {
      if (pc.__kujiraNetTimer) return;
      kujiraReportNet(pc);
      pc.__kujiraNetTimer = setInterval(() => {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          clearInterval(pc.__kujiraNetTimer); pc.__kujiraNetTimer = null; return;
        }
        kujiraReportNet(pc);
      }, 5000);
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') start();
    });
    if (pc.connectionState === 'connected') start();
  };

  Object.defineProperty(KujiraPeerConnection, 'name', { value: 'RTCPeerConnection' });
  window.RTCPeerConnection = KujiraPeerConnection;

  console.log('[KUJIRA-TURN] RTCPeerConnection wrapped — TURN relay fallback active');
})();
