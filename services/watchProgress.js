// services/watchProgress.js — [juntos repaginado 2026-10-21] "Continuar assistindo" do catálogo.
// O servidor não guarda histórico (watch.php só tem a sessão viva por conversa), então a sala de vídeo
// grava aqui, no aparelho, onde parou: {key, cid, name, item, pos, dur, at}. Só entra quando assistiu
// ≥ 60 s e faltam ≥ 2 min; terminou → sai. Máx. 12 itens, 30 dias.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'chatyy_watch_progress_v1';
const MAX = 12;
const TTL = 30 * 24 * 3600 * 1000;
let _mem = null;

async function _load() {
  if (_mem) return _mem;
  try { const raw = await AsyncStorage.getItem(KEY); const a = raw ? JSON.parse(raw) : []; _mem = Array.isArray(a) ? a : []; } catch { _mem = []; }
  return _mem;
}
function _save() { try { AsyncStorage.setItem(KEY, JSON.stringify(_mem || [])).catch(() => {}); } catch {} }

/** Grava o ponto (item de vídeo da conversa cid). */
export async function saveProgress(cid, name, item, pos, dur) {
  if (!cid || !item || !item.id || item.kind === 'audio') return;
  const list = await _load();
  const key = String(cid) + '|' + String(item.id);
  const rest = list.filter((x) => x && x.key !== key);
  const d = Number(dur) || Number(item.dur) || 0;
  const p = Number(pos) || 0;
  if (p >= 60 && d > 0 && d - p >= 120) {
    const it = {
      id: item.id, kind: item.kind, title: item.title, author: item.author, year: item.year, dur: item.dur, url: item.url,
      thumb: item.thumb, mime: item.mime, source: item.source, lic: item.lic, lic_url: item.lic_url, credit: item.credit, message_id: item.message_id,
    };
    rest.unshift({ key, cid: String(cid), name: String(name || ''), item: it, pos: Math.round(p), dur: d, at: Date.now() });
  }
  _mem = rest.slice(0, MAX);
  _save();
}

/** Lista recente (mais novo primeiro); cid = só desta conversa primeiro. */
export async function listProgress(cid) {
  const now = Date.now();
  const list = (await _load()).filter((x) => x && x.item && now - Number(x.at || 0) < TTL);
  if (!cid) return list;
  const mine = list.filter((x) => x.cid === String(cid));
  return mine.concat(list.filter((x) => x.cid !== String(cid)));
}

export async function clearProgress(cid, itemId) {
  const list = await _load();
  _mem = list.filter((x) => x && x.key !== String(cid) + '|' + String(itemId));
  _save();
}
