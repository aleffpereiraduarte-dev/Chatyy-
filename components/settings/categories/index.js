// [2026-10-15 settings-split] Registro das categorias das Configurações.
//
// A raiz (app/settings.js) só conhece este catálogo + o índice de busca; o
// código de cada categoria é carregado SOB DEMANDA:
//   • nativo: require() síncrono no 1º uso (o Metro só AVALIA o módulo quando
//     a categoria abre — nada de "piscar" um fallback do Suspense);
//   • web: React.lazy(import()) → chunk separado no export (code-splitting).
import React from 'react';
import { LOADERS, ASYNC } from './loaders';

// key interna (gates/âncoras antigas) → título (i18n) e ícone.
export const CATEGORY_GROUPS = [
  ['account', 'privacy', 'chat', 'notifications', 'storage_data'],
  ['accessibility', 'language'],
  ['email', 'bia'],
  ['help', 'invite'],
];
export const GROUP_HEADER_KEYS = ['notif.general', 'settings.preferences', 'chat.apps', 'settings.support'];

export const CATEGORY_META = {
  account: { icon: 'user', titleKey: 'settings.cat.account', fb: 'Conta' },
  privacy: { icon: 'shield', titleKey: 'settings.cat.privacyOnly', fb: 'Privacidade' },
  chat: { icon: 'message', titleKey: 'settings.cat.chats', fb: 'Conversas' },
  notifications: { icon: 'bell', titleKey: 'settings.cat.notifications', fb: 'Notificações' },
  storage_data: { icon: 'database', titleKey: 'settings.cat.storageData', fb: 'Armazenamento e dados' },
  accessibility: { icon: 'type', titleKey: 'settings.cat.accessibility', fb: 'Acessibilidade' },
  language: { icon: 'globe', titleKey: 'settings.cat.language', fb: 'Idioma' },
  email: { icon: 'mail', titleKey: 'settings.cat.email', fb: 'Email' },
  bia: { icon: 'sparkles', titleKey: 'settings.cat.bia', fb: 'Bia' },
  help: { icon: 'help', titleKey: 'settings.cat.help', fb: 'Ajuda e sobre' },
  invite: { icon: 'userPlus', titleKey: 'settings.cat.invite', fb: 'Convidar amigos' },
};
export function categoryTitle(t, key) {
  const m = CATEGORY_META[key];
  if (!m) return t('settings.title');
  return t(m.titleKey) || m.fb;
}

// ?section=<âncora|categoria> → categoria (links antigos: perfil,
// QuickSettings, notificações…).
const SECTION_TO_CATEGORY = {
  account: 'account', profile: 'account', security: 'account', devices: 'account', one: 'account',
  privacy: 'privacy', privacy_granular: 'privacy', defaultDisappearing: 'privacy', blocked: 'privacy',
  chat: 'chat', chats: 'chat', appearance: 'chat', theme: 'chat', wallpaper: 'chat', mutedWords: 'chat', mediaVisibility: 'chat',
  notifications: 'notifications',
  storage: 'storage_data', storage_data: 'storage_data', mediaAutoDownload: 'storage_data', data: 'storage_data',
  accessibility: 'accessibility', reading: 'accessibility', fontSize: 'accessibility',
  language: 'language',
  email: 'email', vacation: 'email', forwarding: 'email',
  bia: 'bia', ai: 'bia',
  help: 'help', about: 'help', support: 'help',
  invite: 'invite', referral: 'invite',
};
export function sectionToCategory(section) {
  if (!section || typeof section !== 'string') return null;
  return SECTION_TO_CATEGORY[section] || null;
}

// ── Carregamento sob demanda (loaders.native.js / loaders.js) ────────────
const _cache = {};
const _ready = {}; // web: módulo já baixado → componente direto (sem Suspense)
/** Componente da categoria (ou null se a chave não existe). */
export function getCategoryComponent(key) {
  if (_ready[key]) return _ready[key];
  if (_cache[key]) return _cache[key];
  const load = LOADERS[key];
  if (!load) return null;
  if (ASYNC) {
    _cache[key] = React.lazy(load);
  } else {
    const mod = load();
    _cache[key] = (mod && mod.default) || mod;
  }
  return _cache[key];
}
/** Web: baixa o chunk antes do toque (a categoria abre sem esperar a rede). */
export function preloadCategory(key) {
  if (!ASYNC) return;
  if (_ready[key]) return;
  try {
    const p = LOADERS[key]?.();
    if (p && p.then) p.then((m) => { const c = (m && m.default) || m; if (c) _ready[key] = c; }).catch(() => {});
  } catch {}
}
