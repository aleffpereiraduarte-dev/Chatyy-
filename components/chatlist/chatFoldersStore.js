// [2026-10-16 wave12-B pastas] Store único das LISTAS de conversa (Telegram
// "Pastas" / WhatsApp "Listas"). Lido por ChatListTab (chips + filtro) e pela
// tela /chat-folders via useSyncExternalStore (React Compiler ligado → nada de
// mutação escondida: cada mudança troca o snapshot e avisa os assinantes).
//
// Servidor (chat.php chat_folders_*): create força filter_type='manual' e o
// update NÃO aceita filter_type/filter_value → as REGRAS rápidas viajam no
// campo `icon` (VARCHAR, corta em 10 chars), num formato compacto:
//   "~<ícone 2 letras>.<flags>"   ex.: "~wk.gca" = maleta, grupos+contatos, sem arquivadas
//   flags incluir:  u=não lidas  c=contatos  g=grupos  h=canais
//   flags excluir:  a=arquivadas m=silenciadas
// Ícone antigo (emoji '📂' do "Adicionar a lista") = sem ícone e sem regras.
// Assim a regra sincroniza entre aparelhos sem mudar o PHP.
import { useSyncExternalStore } from 'react';
import * as api from '../../services/api';

export const FOLDER_ICON_KEYS = ['st', 'hr', 'wk', 'hm', 'us', 'ms', 'bk', 'fl', 'zp', 'gl', 'mc', 'ca', 'gf', 'bl', 'aw', 'sh', 'tg', 'cl', 'bd', 'fd'];
const RULE_FLAGS = 'ucgham';

export function parseFolderIcon(icon) {
  const s = String(icon || '');
  if (s.charAt(0) !== '~') return { iconKey: '', rules: {} };
  const dot = s.indexOf('.');
  const key = (dot >= 0 ? s.slice(1, dot) : s.slice(1)).slice(0, 2);
  const flags = dot >= 0 ? s.slice(dot + 1) : '';
  const rules = {};
  for (const ch of flags) if (RULE_FLAGS.includes(ch)) rules[ch] = true;
  return { iconKey: FOLDER_ICON_KEYS.includes(key) ? key : '', rules };
}

export function encodeFolderIcon(iconKey, rules) {
  const flags = RULE_FLAGS.split('').filter(ch => rules && rules[ch]).join('');
  const key = FOLDER_ICON_KEYS.includes(iconKey) ? iconKey : '';
  if (!key && !flags) return '';
  return `~${key}.${flags}`.slice(0, 10);
}

export function folderIds(folder) {
  const ids = Array.isArray(folder?.conversation_ids) ? folder.conversation_ids : [];
  const out = new Set();
  for (const x of ids) { const n = Number(x); if (n) out.add(n); }
  return out;
}

// Pré-calcula (ids + regras) uma vez por pasta — o filtro roda por linha.
export function folderMatcher(folder) {
  const ids = folderIds(folder);
  const { rules } = parseFolderIcon(folder?.icon);
  const fn = (c, isArchived) => {
    if (!c) return false;
    if (isArchived && rules.a) return false;
    if (rules.m && c.muted) return false;
    if (ids.has(Number(c.id))) return true;
    const ty = c.type || 'direct';
    if (rules.g && ty === 'group') return true;
    if (rules.h && ty === 'channel') return true;
    if (rules.c && ty !== 'group' && ty !== 'channel') return true;
    if (rules.u && (c.unread_count || 0) > 0) return true;
    return false;
  };
  fn.includesArchived = !rules.a;
  return fn;
}

// ── estado ───────────────────────────────────────────────────────────────
let _state = { acct: '', items: [], loaded: false };
const _subs = new Set();
function _emit() { for (const f of _subs) { try { f(); } catch {} } }
function _acct() { try { return String(api.getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; } }
function _sort(list) {
  return list.slice().sort((a, b) => ((a.position || 0) - (b.position || 0)) || (Number(a.id) - Number(b.id)));
}
function _set(items, extra) {
  _state = { ..._state, ...(extra || {}), items: _sort(items) };
  _emit();
}
function _checkAcct() {
  const a = _acct();
  if (a !== _state.acct) _state = { acct: a, items: [], loaded: false };
}

export function subscribeFolders(cb) { _subs.add(cb); return () => { _subs.delete(cb); }; }
export function getFoldersSnapshot() { return _state; }
export function useChatFolders() {
  return useSyncExternalStore(subscribeFolders, getFoldersSnapshot, getFoldersSnapshot);
}

// Atualização local (funções antigas do ChatListTab usam setChatFolders(prev => …)).
export function setFolderItems(next) {
  _checkAcct();
  const items = typeof next === 'function' ? next(_state.items) : next;
  _set(Array.isArray(items) ? items : []);
}

let _inflight = null;
export function loadFolders() {
  _checkAcct();
  if (_inflight) return _inflight;
  const acct = _state.acct;
  _inflight = api.chatFoldersList().then(r => {
    if (acct !== _acct()) return;
    if (r?.success && r?.data) {
      const raw = Array.isArray(r.data.items) ? r.data.items : (Array.isArray(r.data.folders) ? r.data.folders : []);
      // Só listas do usuário (as "seed" all/type duplicavam os chips fixos — 2026-05-29).
      _set(raw.filter(f => (f?.filter_type || 'manual') === 'manual'), { loaded: true });
    }
  }).catch(() => {}).finally(() => { _inflight = null; });
  return _inflight;
}

function _ok(r) { return !(r && r.success === false); }

export async function createFolder({ name, iconKey, rules, ids }) {
  _checkAcct();
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return { ok: false };
  const icon = encodeFolderIcon(iconKey, rules);
  const convIds = Array.from(new Set((ids || []).map(Number).filter(Boolean))).slice(0, 500);
  const position = _state.items.reduce((m, f) => Math.max(m, Number(f.position) || 0), -1) + 1;
  try {
    const r = await api.chatFoldersCreate(nm, icon, 'manual', null);
    const id = Number(r?.data?.id) || 0;
    if (!r?.success || !id) return { ok: false, error: r?.message || r?.error };
    // create do api.js não repassa conversation_ids → 1 update com ids + posição.
    const u = await api.chatFoldersUpdate(id, { conversation_ids: convIds, position, icon, name: nm });
    const folder = { id, name: nm, icon, conversation_ids: convIds, filter_type: 'manual', position };
    _set([..._state.items.filter(f => Number(f.id) !== id), folder]);
    return { ok: _ok(u), id, existing: !!r?.data?.existing };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function updateFolder(id, { name, iconKey, rules, ids }) {
  _checkAcct();
  const prev = _state.items;
  const cur = prev.find(f => Number(f.id) === Number(id));
  if (!cur) return { ok: false };
  const patch = {};
  if (name != null) patch.name = String(name).trim().slice(0, 40);
  if (iconKey !== undefined || rules !== undefined) {
    const p = parseFolderIcon(cur.icon);
    patch.icon = encodeFolderIcon(iconKey !== undefined ? iconKey : p.iconKey, rules !== undefined ? rules : p.rules);
  }
  if (ids) patch.conversation_ids = Array.from(new Set(ids.map(Number).filter(Boolean))).slice(0, 500);
  _set(prev.map(f => (Number(f.id) === Number(id) ? { ...f, ...patch } : f)));
  try {
    const r = await api.chatFoldersUpdate(id, patch);
    if (!_ok(r)) { _set(prev); return { ok: false, error: r?.message }; }
    return { ok: true };
  } catch (e) { _set(prev); return { ok: false, error: e?.message }; }
}

export async function deleteFolder(id) {
  _checkAcct();
  const prev = _state.items;
  _set(prev.filter(f => Number(f.id) !== Number(id)));
  try {
    const r = await api.chatFoldersDelete(id);
    if (!_ok(r)) { _set(prev); return { ok: false }; }
    return { ok: true };
  } catch { _set(prev); return { ok: false }; }
}

// Nova ordem (ids). Só grava a posição das que mudaram.
export async function reorderFolders(orderIds) {
  _checkAcct();
  const prev = _state.items;
  const byId = new Map(prev.map(f => [Number(f.id), f]));
  const next = [];
  orderIds.forEach((id, i) => { const f = byId.get(Number(id)); if (f) next.push({ ...f, position: i }); });
  for (const f of prev) if (!orderIds.map(Number).includes(Number(f.id))) next.push({ ...f, position: next.length });
  const changed = next.filter(f => (byId.get(Number(f.id))?.position ?? -1) !== f.position);
  _set(next);
  if (!changed.length) return { ok: true };
  try {
    const rs = await Promise.all(changed.map(f => api.chatFoldersUpdate(f.id, { position: f.position })));
    if (rs.some(r => !_ok(r))) { _set(prev); return { ok: false }; }
    return { ok: true };
  } catch { _set(prev); return { ok: false }; }
}

// ── foto das conversas p/ o seletor (não reativo; o ChatListTab publica) ──
let _convSnap = { acct: '', active: [], archived: [] };
export function publishConversations(active, archived) {
  _convSnap = { acct: _acct(), active: Array.isArray(active) ? active : [], archived: Array.isArray(archived) ? archived : [] };
}
export function getConversationsSnapshot() {
  return _convSnap.acct === _acct() ? _convSnap : { acct: '', active: [], archived: [] };
}
