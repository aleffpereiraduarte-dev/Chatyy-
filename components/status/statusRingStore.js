// [status-rever 2026-10-14] "Depois que vejo o status de alguém, deveria poder
// ver de novo" (founder). Fonte única, leve, de QUEM tem status ativo e se eu
// já vi tudo — alimentada pelo useStatuses (status_list/manifest, já com as
// regras de privacidade do servidor: só vem o que eu posso abrir).
//
//   useStatusRing(email) → null | { count, allViewed }
//   openStatusFor(email) → abre o viewer (registrado pela aba de conversas)
//
// Qualquer superfície (linha da lista de conversas, cabeçalho da conversa,
// perfil) desenha o anel: destacado se há item não visto, cinza se tudo visto.
import { useEffect, useState } from 'react';

let _rings = new Map(); // email(lower) → { count, allViewed }
const _listeners = new Set();
let _opener = null;
// Ids já vistos nesta sessão. Cada tela tem sua instância do useStatuses e a
// última a re-buscar escrevia aqui — um status_list que voltou ANTES do
// status_view gravar repintava o anel de "novo". Visto é monotônico.
const _seenIds = new Set();
let _lastMe = '';

function _key(v) { return v ? `${v.count}|${v.allViewed ? 1 : 0}|${(v.viewed || []).map(x => (x ? 1 : 0)).join('')}` : ''; }

export function setStatusRingsFromGroups(groups, myEmail) {
  const me = String(myEmail || '').toLowerCase();
  if (me !== _lastMe) { _seenIds.clear(); _lastMe = me; } // troca de conta
  const next = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const em = String(g?.email || g?.ownerEmail || '').toLowerCase();
    const items = (g?.items || []).filter(Boolean);
    if (!em || em === me || !items.length) continue;
    for (const it of items) if (it.viewed && it.id != null && !it._placeholder) _seenIds.add(String(it.id));
    const viewed = items.map(it => !!it.viewed || (it.id != null && _seenIds.has(String(it.id))));
    next.set(em, { _ids: items.map(it => String(it.id)), count: items.length, viewed, allViewed: viewed.every(Boolean) });
  }
  // Entradas vindas do manifest (perfil aberto direto) ficam até um status_list
  // real trazer aquele dono — uma instância com lista vazia não as apaga.
  if (!next.size) for (const [k, v] of _rings) { if (v._primed) next.set(k, v); }
  // Notifica só se algo mudou (evita re-render de todas as linhas a cada poll).
  let changed = next.size !== _rings.size;
  if (!changed) for (const [k, v] of next) { if (_key(_rings.get(k)) !== _key(v)) { changed = true; break; } }
  if (!changed) return;
  _rings = next;
  try { globalThis.__chatyyStatusRings = next; } catch {} // QA/diagnóstico
  _listeners.forEach(fn => { try { fn(); } catch {} });
}

// Chamado pelo markViewed do useStatuses (otimista, antes do servidor).
export function markRingItemViewed(statusId) {
  if (statusId == null) return;
  _seenIds.add(String(statusId));
  let changed = false;
  for (const [k, v] of _rings) {
    if (v.allViewed || !v._ids || !v._ids.includes(String(statusId))) continue;
    const viewed = v._ids.map((id, i) => _seenIds.has(id) || !!(v.viewed && v.viewed[i]));
    _rings.set(k, { ...v, viewed, allViewed: viewed.every(Boolean) }); changed = true;
  }
  if (changed) _listeners.forEach(fn => { try { fn(); } catch {} });
}

// apitest@onemundo.com.br e apitest@chatyy.com.br são a MESMA conta (o chat
// reescreve o domínio legado) — perfil/linha podem trazer um, o status o outro.
function _alias(em) {
  if (em.endsWith('@onemundo.com.br')) return em.replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
  if (em.endsWith('@chatyy.com.br')) return em.replace(/@chatyy\.com\.br$/, '@onemundo.com.br');
  return null;
}
export function getStatusRing(email) {
  const em = String(email || '').toLowerCase();
  if (!em) return null;
  const a = _alias(em);
  return _rings.get(em) || (a ? _rings.get(a) : null) || null;
}

export function useStatusRing(email) {
  const em = String(email || '').toLowerCase();
  const [val, setVal] = useState(() => (em ? getStatusRing(em) : null));
  useEffect(() => {
    if (!em) { setVal(null); return undefined; }
    const fn = () => {
      const v = getStatusRing(em);
      setVal(prev => (_key(prev) === _key(v) ? prev : v));
    };
    fn();
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, [em]);
  return val;
}

// [2026-10-14 native-home] Assinatura bruta (lista nativa da home: um único
// listener para todas as linhas em vez de um hook por linha). Devolve o unsubscribe.
export function subscribeStatusRings(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function registerStatusOpener(fn) {
  _opener = typeof fn === 'function' ? fn : null;
  return () => { if (_opener === fn) _opener = null; };
}

export function openStatusFor(email) {
  if (!email || !_opener) return false;
  const em = String(email).toLowerCase();
  const a = _alias(em);
  const target = _rings.has(em) || !a || !_rings.has(a) ? email : a;
  try { _opener(target); return true; } catch { return false; }
}

export function clearStatusRings() {
  _rings = new Map();
  _seenIds.clear();
  _listeners.forEach(fn => { try { fn(); } catch {} });
}

// Perfil aberto direto (deep link /u/…) sem a lista de conversas montada: o
// store está vazio. Busca o status_manifest (leve, mesmas regras de
// privacidade) no máximo 1x/60 s e preenche SÓ e-mails ainda desconhecidos
// (nunca sobrescreve o que veio do status_list completo).
let _primeAt = 0;
export async function primeStatusRings() {
  if (Date.now() - _primeAt < 60000) return;
  _primeAt = Date.now();
  try {
    const api = require('../../services/api');
    const r = await (api.statusManifest ? api.statusManifest() : api.apiCall('status_manifest'));
    const users = r?.data?.users || [];
    try { globalThis.__chatyyStatusPrime = { at: Date.now(), ok: !!r?.success, n: users.length }; } catch {}
    let changed = false;
    const next = new Map(_rings);
    for (const u of users) {
      const em = String(u?.email || '').toLowerCase();
      if (!em || u?.is_own || next.has(em) || !(Number(u.count) > 0)) continue;
      const c = Number(u.count) || 1, un = Math.max(0, Math.min(c, Number(u.unviewed) || 0));
      next.set(em, { _primed: true, _ids: [], count: c, viewed: Array.from({ length: c }, (_, i) => i < c - un), allViewed: un === 0 });
      changed = true;
    }
    if (!changed) return;
    _rings = next;
    try { globalThis.__chatyyStatusRings = next; } catch {}
    _listeners.forEach(fn => { try { fn(); } catch {} });
  } catch (e) { try { globalThis.__chatyyStatusPrime = { err: String(e?.message || e) }; } catch {} }
}

// [status-texto 2026-10-14] Abrir o editor de status de TEXTO de qualquer
// câmera de status (aba de conversas, perfil). Registrado pelo ChatStatusTab,
// que hospeda o StatusStudio.
let _textOpener = null;
export function registerTextStatusOpener(fn) {
  _textOpener = typeof fn === 'function' ? fn : null;
  return () => { if (_textOpener === fn) _textOpener = null; };
}
export function openTextStatusComposer() {
  if (!_textOpener) return false;
  try { _textOpener(); return true; } catch { return false; }
}
