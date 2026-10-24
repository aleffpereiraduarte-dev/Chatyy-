// [bia-temp 2026-10-24] Conversa TEMPORÁRIA da Bia (estilo "chat temporário" do ChatGPT).
//
// Estado do modo é só da sessão da tela (memória do JS, nunca disco). Enquanto ativo:
//   - o app manda temp=1 em tudo o que é da Bia (texto, voz realtime, ferramentas da voz,
//     TTS, transcrição) → o servidor não grava conversa/mensagens/memória/logs com conteúdo
//     (kit /root/bia-temporario-2026-10-24);
//   - o histórico do turno vai do aparelho (temp_history) e mora só no estado React da tela;
//   - nada vai para MMKV/AsyncStorage (cache de conversa, espelho da thread);
//   - TTS nativo usa tid (áudio em RAM no servidor por 120 s), sem texto na URL;
//   - ao sair do modo/da tela, purgeTempTts() apaga os áudios temporários do servidor.
// A única coisa salva no aparelho é a preferência "Começar sempre no modo temporário"
// (biaPrefs.biaTempStartAlways), que não tem conteúdo de conversa.
import * as api from './api';

let _active = false;
const _subs = new Set();

export function isBiaTempActive() { return _active; }

export function setBiaTempActive(on) {
  const v = !!on;
  if (v === _active) return;
  _active = v;
  _subs.forEach((fn) => { try { fn(v); } catch {} });
}

export function onBiaTempChange(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

// Servidor anuncia o suporte em one_status (temp_mode=1). Sem suporte = NÃO liga
// (um servidor antigo gravaria a conversa normalmente). Resultado positivo fica em memória.
let _supported = null;
export async function biaTempSupported() {
  if (_supported === true) return true;
  try {
    const r = await api.apiCall('one_status', {}, 'POST');
    _supported = !!(r && r.success && r.data && Number(r.data.temp_mode) === 1);
  } catch { _supported = false; }
  return _supported;
}

// Histórico do turno (só o que está na tela). Últimas 20 falas com texto.
export function buildTempHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m._streaming || m._toolPending) continue;
    const c = typeof m.content === 'string' ? m.content.trim() : '';
    if (!c) continue;
    out.push({ role: m.role, content: c.slice(0, 6000) });
  }
  return out.slice(-20);
}

// TTS temporário: o servidor gera e guarda em RAM (120 s); o player toca por tid.
const _ttsTid = new Map(); // texto → Promise<url|null> (só memória, some com o modo)
export function tempTtsUrl(text) {
  if (!text) return Promise.resolve(null);
  if (_ttsTid.has(text)) return _ttsTid.get(text);
  const p = api.apiCall('one_tts', { text, temp: 1, prepare: 1 }, 'POST')
    .then((r) => {
      const tid = r && r.success && r.data && r.data.tid;
      return tid ? api.oneTTSTempUrl(tid) : null;
    })
    .catch(() => null);
  _ttsTid.set(text, p);
  if (_ttsTid.size > 40) { const k = _ttsTid.keys().next().value; _ttsTid.delete(k); }
  return p;
}

export function purgeTempTts() {
  _ttsTid.clear();
  try { api.apiCall('one_tts', { temp: 1, purge: 1 }, 'POST').catch(() => {}); } catch {}
}
