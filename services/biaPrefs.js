// [2026-10-21 bia-ajustes] Preferências LOCAIS da Bia (aparelho), usadas pela
// tela da Bia (app/one.js), pelo cartão da lista (biaDaily) e pelos Ajustes
// (components/settings/categories/BiaCategory.js):
//   bia_pref_tts_rate   velocidade das respostas lidas em voz alta (0.8 | 1 | 1.25 | 1.5)
//   bia_pref_auto_read  "Mãos livres": lê as respostas em voz alta assim que chegam ('1' | '0')
//   bia_pref_daily      frase do dia no início (padrão ligado; '0' = desligado)
// As preferências do SERVIDOR (tom, tamanho, idioma, voz, memória, acesso a dados)
// continuam em ai_memory (email.php → ai-memory.php).
import { getString, setString } from './mmkv';

export const BIA_TTS_RATES = [0.8, 1, 1.25, 1.5];

function _get(k) { try { return getString(k); } catch { return null; } }
function _set(k, v) { try { setString(k, v); } catch {} }

export function biaTtsRate() {
  const n = parseFloat(_get('bia_pref_tts_rate') || '');
  return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
}
export function setBiaTtsRate(r) { _set('bia_pref_tts_rate', String(r)); }

export function biaAutoRead() { return _get('bia_pref_auto_read') === '1'; }
export function setBiaAutoRead(on) { _set('bia_pref_auto_read', on ? '1' : '0'); }

export function biaDailyUserOn() { return _get('bia_pref_daily') !== '0'; }
export function setBiaDailyUserOn(on) { _set('bia_pref_daily', on ? '1' : '0'); }

// Vozes aceitas pelo servidor (ai-memory.php aiMemoryVoices; padrão = shimmer).
export const BIA_DEFAULT_VOICE = 'shimmer';
export const BIA_VOICES = [
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'coral', name: 'Coral' },
  { id: 'sage', name: 'Sage' },
  { id: 'marin', name: 'Marin' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'alloy', name: 'Alloy' },
  { id: 'verse', name: 'Verse' },
  { id: 'echo', name: 'Echo' },
  { id: 'ash', name: 'Ash' },
  { id: 'cedar', name: 'Cedar' },
];

// Tom (ai_memory tone): frase em pt que o LLM lê (mesmos valores de app/bia-settings.js).
export const BIA_TONES = [
  { id: 'friendly', phrase: 'Amigável e acolhedor', match: ['amigável', 'amigavel'] },
  { id: 'professional', phrase: 'Profissional e cordial', match: ['profissional'] },
  { id: 'fun', phrase: 'Divertido e descontraído', match: ['divertido'] },
  { id: 'direct', phrase: 'Direto e objetivo', match: ['direto'] },
];
export function biaToneId(raw) {
  const low = String(raw || '').trim().toLowerCase();
  if (!low) return '';
  const tn = BIA_TONES.find(x => x.match.some(m => low.startsWith(m)));
  return tn ? tn.id : 'custom';
}
