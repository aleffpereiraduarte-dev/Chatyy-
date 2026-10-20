// services/muralPrefs.js — [mural 2026-10-20] "Quem vê minhas publicações"
// (padrão para posts novos). Contrato do servidor: public | contacts | private.
// Guardado no aparelho (o compositor lê getDefaultAudience()); sem ação de
// servidor própria no API.md.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mural_default_audience_v1';
const VALID = ['public', 'contacts', 'private'];
let _val = null;
let _loaded = false;
const _subs = new Set();

function _norm(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'everyone') return 'public';
  if (s === 'only_me' || s === 'me') return 'private';
  return VALID.includes(s) ? s : 'public';
}

export async function loadDefaultAudience() {
  if (_loaded) return _val || 'public';
  try { const v = await AsyncStorage.getItem(KEY); _val = v ? _norm(v) : 'public'; } catch { _val = 'public'; }
  _loaded = true;
  for (const fn of Array.from(_subs)) { try { fn(_val); } catch {} }
  return _val;
}

export function getDefaultAudience() { return _val || 'public'; }

export async function setDefaultAudience(v) {
  _val = _norm(v);
  _loaded = true;
  for (const fn of Array.from(_subs)) { try { fn(_val); } catch {} }
  try { await AsyncStorage.setItem(KEY, _val); } catch {}
  return _val;
}

export function subscribeDefaultAudience(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
