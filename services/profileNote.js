// [2026-10-20 nota-perfil] Nota do perfil estilo Instagram Notes (balão acima
// da foto no "Você"). Servidor: api/profile-note.php (profile_note_get / _set /
// _delete) — até 60 caracteres, some em 24 h, público 'mutual' (seguidores que
// você segue de volta) ou 'contacts'.
// Store pequeno em memória + AsyncStorage (pinta no 1º frame), otimista:
// setNote/deleteNote atualizam o balão NA HORA e revertem se o servidor falhar.
// Kill switch (OTA): globalThis.__chatyy_profile_note_sheet = false → balão
// volta a ser o "recado" que abre o editar perfil (comportamento anterior).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export const NOTE_MAX = 60;
const KEY = 'chatyy_profile_note_v1';

let _note = null; // { text, audience, created_at, expires_at } | null
let _owner = ''; // conta dona da nota em cache (troca de conta não mostra a nota da outra)
let _loaded = false;
let _srv = false; // servidor já respondeu nesta conta → cópia local não sobrescreve
const _subs = new Set();

export function profileNoteSheetOn() {
  try { return globalThis.__chatyy_profile_note_sheet !== false; } catch { return true; }
}

function _alive(n) {
  if (!n || !n.text) return null;
  const exp = Date.parse(n.expires_at || '');
  if (exp && exp <= Date.now()) return null;
  return n;
}

function _emit(n) {
  _note = _alive(n);
  try { AsyncStorage.setItem(KEY, JSON.stringify({ owner: _owner, note: _note })); } catch {}
  _subs.forEach((fn) => { try { fn(_note); } catch {} });
}

export function peekNote() { return _alive(_note); }

async function _loadLocal() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && !_srv && _note === null && (!_owner || j.owner === _owner)) {
      if (!_owner) _owner = j.owner || '';
      const n = _alive(j.note);
      if (n) { _note = n; _subs.forEach((fn) => { try { fn(_note); } catch {} }); }
    }
  } catch {}
}

function _api() { return require('./api'); } // eslint-disable-line global-require
// [nota2] avisa a lista de conversas (mesmo evento que o servidor manda por WS).
function _notifyList() {
  try { require('./websocket').default?._emit?.('profile_note', { email: _owner, local: 1, ts: Date.now() }); } catch {} // eslint-disable-line global-require
}

export async function refreshNote(email) {
  const em = String(email || '').toLowerCase();
  if (em && em !== _owner) { _owner = em; _note = null; _loaded = false; _srv = false; _subs.forEach((fn) => { try { fn(null); } catch {} }); }
  _loadLocal();
  try {
    const r = await _api().apiCall('profile_note_get', {});
    if (r && r.success && r.data && 'note' in r.data) { _srv = true; _emit(r.data.note || null); }
  } catch {}
  return peekNote();
}

/** Otimista: o balão mostra a nota já; se falhar, volta a anterior e devolve false. */
export async function setNote(text, audience) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (!clean) return false;
  const prev = _note;
  const now = Date.now();
  _emit({ text: clean, audience: 'contacts', created_at: new Date(now).toISOString(), expires_at: new Date(now + 24 * 3600 * 1000).toISOString(), pending: true });
  try {
    const r = await _api().apiCall('profile_note_set', { text: clean, audience: 'contacts' }, 'POST');
    if (r && r.success && r.data && r.data.note) { _emit(r.data.note); _notifyList(); return true; }
  } catch {}
  _emit(prev);
  return false;
}

export async function deleteNote() {
  const prev = _note;
  _emit(null);
  try {
    const r = await _api().apiCall('profile_note_delete', {}, 'POST');
    if (r && r.success) { _notifyList(); return true; }
  } catch {}
  _emit(prev);
  return false;
}

export function useProfileNote() {
  const [n, setN] = useState(peekNote);
  useEffect(() => {
    _subs.add(setN);
    _loadLocal();
    setN(peekNote());
    // expira sozinha na tela aberta (24 h)
    const tm = setInterval(() => { const a = peekNote(); setN((cur) => (cur && !a ? null : cur)); }, 60000);
    return () => { _subs.delete(setN); clearInterval(tm); };
  }, []);
  return n;
}
