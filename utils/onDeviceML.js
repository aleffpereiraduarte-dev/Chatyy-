// [2026-10-09 android-ml-parity] Inteligência no aparelho — uma porta só
// para iOS e Android (OTA-safe).
//
//   iOS:     Vision OCR + NaturalLanguage (ExpoNativeChatSecurity) e
//            SFSpeechRecognizer on-device (ExpoNativeToolkit).
//   Android: ML Kit (OCR / Language ID / tradução opcional) + SpeechRecognizer
//            on-device do sistema (Android 13+), no módulo Android
//            ExpoNativeChatSecurity (mesmos nomes/assinaturas do iOS) — só
//            existe a partir do PRÓXIMO binário.
//
// Tudo é sondado com requireOptionalNativeModule NA HORA da chamada (nunca no
// import, nunca requireNativeModule): binário atual / web → capacidades
// false e as funções devolvem { error: 'unavailable' }; quem chama cai no
// servidor como antes.
import { Platform } from 'react-native';

function _optional(name) {
  if (Platform.OS === 'web') return null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    return typeof requireOptionalNativeModule === 'function' ? requireOptionalNativeModule(name) : null;
  } catch {
    return null;
  }
}

let _secMod;
function _sec() {
  if (_secMod !== undefined) return _secMod;
  _secMod = _optional('ExpoNativeChatSecurity');
  return _secMod;
}

let _tkMod;
function _toolkit() {
  if (_tkMod !== undefined) return _tkMod;
  _tkMod = null;
  if (Platform.OS === 'ios') {
    _tkMod = _optional('ExpoNativeToolkit');
  } else if (Platform.OS === 'android') {
    const s = _sec();
    if (s && typeof s.transcribeAudioFile === 'function') _tkMod = s;
  }
  return _tkMod;
}

let _caps;
/**
 * { ocr, languageId, translate, transcribe } — booleans. Síncrono e barato
 * (cacheado). translate=true só no Android com o gate CHATYY_MLKIT_TRANSLATE
 * (o translateText do iOS ainda é stub e devolve o texto original).
 */
export function getOnDeviceCapabilities() {
  if (_caps) return _caps;
  const s = _sec();
  const tk = _toolkit();
  let native = null;
  if (s && typeof s.getOnDeviceCapabilities === 'function') {
    try { native = s.getOnDeviceCapabilities(); } catch { native = null; }
  }
  if (Platform.OS === 'android') {
    _caps = {
      ocr: !!(native?.ocr && s && typeof s.ocrImage === 'function'),
      languageId: !!native?.languageId,
      translate: !!(native?.translate && typeof s?.translateTextOnDevice === 'function'),
      transcribe: !!(native?.transcribe && tk),
    };
  } else if (Platform.OS === 'ios') {
    _caps = {
      ocr: !!(s && typeof s.ocrImage === 'function'),
      languageId: !!(s && typeof s.detectLanguageSync === 'function'),
      translate: false,
      transcribe: !!(tk && typeof tk.transcribeAudioFile === 'function'),
    };
  } else {
    _caps = { ocr: false, languageId: false, translate: false, transcribe: false };
  }
  return _caps;
}

/** Pede ao sistema/Play services para baixar os modelos agora (Wi-Fi). Não lança. */
export async function prepareOnDeviceModels(opts) {
  const s = _sec();
  if (!s || typeof s.prepareOnDeviceModels !== 'function') return false;
  try { return !!(await s.prepareOnDeviceModels(opts || null)); } catch { return false; }
}

/** Idioma do texto ("pt", "en"…) ou "und". Síncrono, nunca lança. */
export function detectLanguageOnDevice(text) {
  const s = _sec();
  if (!s || typeof s.detectLanguageSync !== 'function' || !text) return 'und';
  try { return String(s.detectLanguageSync(String(text)) || 'und'); } catch { return 'und'; }
}

/**
 * Tradução no aparelho. { text, sourceLang } ou { error }.
 * Só Android com o gate de build; nos demais devolve { error: 'unavailable' }.
 */
export async function translateOnDevice(text, targetLang, { sourceLang, allowCellular } = {}) {
  if (!getOnDeviceCapabilities().translate) return { error: 'unavailable' };
  const s = _sec();
  try {
    const r = await s.translateTextOnDevice(String(text || ''), String(targetLang || 'en'), sourceLang || null, !!allowCellular);
    if (r && typeof r.text === 'string') return { text: r.text, sourceLang: r.sourceLang || 'und' };
    return { error: String(r?.error || 'failed'), sourceLang: r?.sourceLang };
  } catch (e) {
    return { error: String(e?.message || e || 'failed') };
  }
}

const _SPEECH_LOCALE = {
  pt: 'pt-BR', 'pt-br': 'pt-BR', 'pt-pt': 'pt-PT', en: 'en-US', es: 'es-ES', fr: 'fr-FR',
  de: 'de-DE', it: 'it-IT', ja: 'ja-JP', hi: 'hi-IN', id: 'id-ID', ar: 'ar-SA',
};
function _speechLocale(lang) {
  const l = String(lang || '').trim().toLowerCase();
  if (!l) return 'pt-BR';
  return _SPEECH_LOCALE[l] || _SPEECH_LOCALE[l.split('-')[0]] || lang;
}

/**
 * Transcrição de áudio no aparelho (o áudio não sai do celular).
 * { text } ou { error }. Baixa o arquivo para o cache se for remoto.
 */
export async function transcribeOnDevice(url, { language, fileName } = {}) {
  if (!getOnDeviceCapabilities().transcribe) return { error: 'unavailable' };
  const tk = _toolkit();
  let local = null;
  try {
    const { ensureLocalFile } = require('./mediaNativeActions');
    local = await ensureLocalFile(url, fileName || 'audio.m4a');
  } catch { local = null; }
  if (!local) return { error: 'download_failed' };
  try {
    if (typeof tk.requestSpeechPermission === 'function') {
      const ok = await tk.requestSpeechPermission();
      if (!ok) return { error: 'permission_denied' };
    }
    const text = await tk.transcribeAudioFile(local, _speechLocale(language));
    const out = String(text || '').trim();
    return out ? { text: out } : { error: 'empty' };
  } catch (e) {
    return { error: String(e?.message || e || 'failed') };
  }
}

/**
 * [2026-10-10 voice-peaks] Waveform REAL de uma nota de voz local, extraída no
 * aparelho logo após gravar (fora da main thread):
 *   - readVoicePeaks (iOS + Android, PRÓXIMO binário): mesma curva do
 *     *.peaks.json do servidor (RMS/50 ms → dB → ^1.7 → média por barra),
 *     então a bolha não "pula" quando o eco do servidor chega;
 *   - readWaveform (iOS, binários atuais): picos normalizados — carrega o
 *     arquivo inteiro na memória, por isso só para notas ≤ 5 min.
 * Devolve `bars` números 0..1, ou null (web / módulo ausente / falha /
 * timeout). O servidor continua sendo a fonte da verdade (ffmpeg astats).
 */
export async function readVoiceWaveform(uri, { bars = 40, timeoutMs = 0, durationSec = 0 } = {}) {
  if (Platform.OS === 'web' || typeof uri !== 'string' || !uri) return null;
  const s = _sec();
  if (!s) return null;
  let p = null;
  try {
    if (typeof s.readVoicePeaks === 'function') {
      p = s.readVoicePeaks(uri, bars);
    } else if (Platform.OS === 'ios' && typeof s.readWaveform === 'function' && !(Number(durationSec) > 300)) {
      p = s.readWaveform(uri, bars);
    }
  } catch { p = null; }
  if (!p || typeof p.then !== 'function') return null;
  p = p.catch(() => null);
  let timer = null;
  const raw = timeoutMs > 0
    ? await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); })])
    : await p;
  if (timer) clearTimeout(timer);
  if (!Array.isArray(raw) || raw.length < 8) return null;
  const src = raw.map((v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; });
  if (!src.some((v) => v > 0.01)) return null; // silêncio total / decode vazio → mantém o fallback
  if (src.length <= bars) return src.map((v) => Math.round(v * 1000) / 1000);
  // readWaveform legado pode devolver bars+1 (resto da divisão) → pico por balde.
  const out = [];
  const step = src.length / bars;
  for (let i = 0; i < bars; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = a; j < b && j < src.length; j++) if (src[j] > peak) peak = src[j];
    out.push(Math.round(peak * 1000) / 1000);
  }
  return out;
}
