// [2026-10-24 midia-wa2] Onda (waveform) do áudio de voz VIAJA COM A MENSAGEM, como no WhatsApp.
//
// O servidor só devolvia a onda real p/ arquivo em /data/chat-files (sidecar .peaks.json no disco
// do US); áudio no R2 (edge BR, URL pré-assinada) chegava ao destinatário com barras falsas.
// Sem mexer no servidor: as 40 barras (0..63, 1 caractere base64url cada) vão no NOME do arquivo
// — o nome é preservado na chave do R2 (presign/Rust/edge) e no /data/chat-files (chat_upload):
//     audio_1792..._w1-<40 chars>.m4a
// App antigo ignora (mostra as barras de sempre). Qualquer destinatário com este JS lê.
//   encodeWaveName(name, waveform)  → nome com a onda (só se a flag do remetente estiver ligada)
//   waveformFromName(urlOuNome)     → number[40] (0..1) | null
// Kill leitura: globalThis.__chatyy_mwa2_wave_read === false.

const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BARS = 40;
const RE = /_w1-([A-Za-z0-9_-]{40})\.(m4a|mp4|aac|ogg|opus|webm|caf|mp3|wav)(?:[?#].*)?$/;

function _resample(wf, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * wf.length / n);
    const b = Math.max(a + 1, Math.floor((i + 1) * wf.length / n));
    let m = 0;
    for (let j = a; j < b && j < wf.length; j++) { const v = Number(wf[j]); if (Number.isFinite(v) && v > m) m = v; }
    out[i] = m;
  }
  return out;
}

export function encodeWave(waveform) {
  if (!Array.isArray(waveform) || waveform.length < 8) return '';
  let max = 0;
  for (const v of waveform) { const x = Number(v); if (Number.isFinite(x) && x > max) max = x; }
  if (!(max > 0)) return '';
  // aceita 0..1 ou 0..100 (o nativo às vezes manda %)
  const scale = max > 1.5 ? 100 : 1;
  const r = _resample(waveform, BARS);
  let s = '';
  for (const v of r) s += ALPH[Math.max(0, Math.min(63, Math.round((Math.max(0, v) / scale) * 63)))];
  return s;
}

export function encodeWaveName(name, waveform) {
  const nm = String(name || '');
  if (!nm || RE.test(nm)) return nm;
  const code = encodeWave(waveform);
  if (!code) return nm;
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(nm);
  const base = (m ? m[1] : nm).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'audio';
  const ext = m ? m[2].toLowerCase() : '.m4a';
  return `${base}_w1-${code}${ext}`;
}

const _cache = new Map();
export function waveformFromName(s) {
  try { if (globalThis.__chatyy_mwa2_wave_read === false) return null; } catch {}
  const str = String(s || '');
  if (str.length < 50 || str.indexOf('_w1-') < 0) return null;
  const m = RE.exec(str);
  if (!m) return null;
  const code = m[1];
  const hit = _cache.get(code);
  if (hit) return hit;
  const out = new Array(BARS);
  for (let i = 0; i < BARS; i++) out[i] = Math.round((ALPH.indexOf(code[i]) / 63) * 100) / 100;
  if (_cache.size > 500) _cache.clear();
  _cache.set(code, out);
  return out;
}

/** Onda de uma mensagem: a do servidor (se houver) senão a do nome do arquivo. */
export function waveformOf(m) {
  if (!m) return null;
  if (Array.isArray(m.waveform) && m.waveform.length >= 8) return m.waveform;
  return waveformFromName(m.file_url) || waveformFromName(m.file_name) || null;
}

export default { encodeWave, encodeWaveName, waveformFromName, waveformOf };
