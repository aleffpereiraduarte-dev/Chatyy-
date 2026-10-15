// [2026-10-15 bia-design] Nível de áudio 0..1 de um MediaStream (web) p/ o orb da Bia
// reagir à voz. Um AnalyserNode por stream (cacheado); leitura síncrona barata.
// Fora do web (ou sem Web Audio) devolve 0 — o modo voz nativo usa o metering do
// gravador (voiceLevelRef em app/one.js).
import { Platform } from 'react-native';

export function createStreamLevelMeter() {
  let ctx = null;
  let cur = { stream: null, analyser: null, buf: null, src: null };
  const close = () => {
    try { cur.src?.disconnect?.(); } catch {}
    cur = { stream: null, analyser: null, buf: null, src: null };
  };
  return {
    get(stream) {
      if (Platform.OS !== 'web' || !stream || typeof window === 'undefined') return 0;
      try {
        if (cur.stream !== stream) {
          close();
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return 0;
          if (!ctx) ctx = new AC();
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.6;
          src.connect(analyser);
          cur = { stream, analyser, buf: new Uint8Array(analyser.fftSize), src };
        }
        const { analyser, buf } = cur;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        return Math.max(0, Math.min(1, rms * 4.2));
      } catch { return 0; }
    },
    dispose() {
      close();
      try { ctx?.close?.(); } catch {}
      ctx = null;
    },
  };
}

// dBFS do metering do expo-audio (-60..0) → 0..1
export function dbToLevel(db) {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 55) / 45));
}
