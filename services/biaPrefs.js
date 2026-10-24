// [2026-10-21 bia-ajustes] Preferências LOCAIS da Bia (aparelho), usadas pela
// tela da Bia (app/one.js), pelo cartão da lista (biaDaily) e pelos Ajustes
// (components/settings/categories/BiaCategory.js):
//   bia_pref_tts_rate   velocidade das respostas lidas em voz alta (0.8 | 1 | 1.25 | 1.5)
//   bia_pref_auto_read  "Mãos livres": lê as respostas em voz alta assim que chegam ('1' | '0')
//   bia_pref_daily      frase do dia no início (padrão ligado; '0' = desligado)
// As preferências do SERVIDOR (tom, tamanho, idioma, voz, memória, acesso a dados)
// continuam em ai_memory (email.php → ai-memory.php).
import { getString, setString, remove as mmkvRemove, getAllKeys } from './mmkv';

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

// [bia-temp 2026-10-24] "Começar sempre no modo temporário" (só a escolha; nada da conversa)
export function biaTempStartAlways() { return _get('bia_pref_temp_start') === '1'; }
export function setBiaTempStartAlways(on) { _set('bia_pref_temp_start', on ? '1' : '0'); }

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

// ── [2026-10-21 bia-cache] conversa atual da Bia salva no aparelho (por conta) ──
// Abre a Bia JÁ com o histórico no 1º quadro (como o WhatsApp); o servidor só
// sincroniza por trás. MMKV síncrono (chave não é lazy). Limpa no "Apagar conversas
// com a Bia" e no logout (AuthContext.clearAccountScopedMmkv → clearBiaThreads).
const THREAD_PFX = 'bia_thread_v1_';
const THREAD_MAX = 60;
function _acctKey(email) { return THREAD_PFX + String(email || 'anon').trim().toLowerCase(); }
function _slimMsg(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  const content = typeof m.content === 'string' ? m.content : '';
  const img = typeof m.imageUri === 'string' && !/^data:/i.test(m.imageUri) ? m.imageUri : undefined;
  if (!content && !img) return null;
  const o = { id: m.id, role: m.role, content };
  if (m.serverId) o.serverId = m.serverId;
  if (m.ts) o.ts = m.ts;
  else if (typeof m.id === 'number' && m.id > 1e12) o.ts = m.id;
  if (img) o.imageUri = img;
  if (Array.isArray(m.actions) && m.actions.length) {
    try { const s = JSON.stringify(m.actions); if (s.length < 20000) o.actions = m.actions; } catch {}
  }
  return o;
}
function _tsOf(m) {
  if (!m) return NaN;
  const v = m.ts;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    let s = v.trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
    const n = Date.parse(s);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
/** { cid, msgs, at } ou null. `at` = hora da última mensagem (regra das 2 h da tela). */
export function readBiaThread(email) {
  try {
    const raw = getString(_acctKey(email));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.msgs)) return null;
    return v;
  } catch { return null; }
}
export function writeBiaThread(email, cid, messages) {
  try {
    if (!cid || !Array.isArray(messages)) return;
    const msgs = messages.map(_slimMsg).filter(Boolean).slice(-THREAD_MAX);
    if (!msgs.length) return;
    let at = NaN;
    for (let i = msgs.length - 1; i >= 0 && !Number.isFinite(at); i--) at = _tsOf(msgs[i]);
    if (!Number.isFinite(at)) at = Date.now();
    setString(_acctKey(email), JSON.stringify({ cid, msgs, at }));
  } catch {}
}
export function removeBiaThread(email) {
  try { mmkvRemove(_acctKey(email)); } catch {}
}
export function clearBiaThreads() {
  try {
    (getAllKeys() || []).forEach((k) => { if (String(k).startsWith(THREAD_PFX)) mmkvRemove(k); });
  } catch {}
}
