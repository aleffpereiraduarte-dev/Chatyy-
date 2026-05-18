// services/webBadge.js — atualiza document.title + navigator.setAppBadge
// com unread count consolidado (chat + inbox). WhatsApp Web parity: "(7) Chatyy"
// no tab + dock badge numérico. NO-OP em iOS/Android.
//
// API:
//   setChatUnread(n)   → unread total de conversas
//   setInboxUnread(n)  → unread emails
//   clearAll()         → quando user marca tudo lido
//
// O serviço soma e aplica throttle (500ms) pra não thrashar o title.

import { Platform } from 'react-native';

const BASE_TITLE = 'Chatyy';
const THROTTLE_MS = 500;

let _chat = 0;
let _inbox = 0;
let _applyTimer = null;
let _lastApplied = -1;

function _scheduleApply() {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;
  if (_applyTimer) return;
  _applyTimer = setTimeout(() => {
    _applyTimer = null;
    _apply();
  }, THROTTLE_MS);
}

function _apply() {
  if (Platform.OS !== 'web') return;
  const total = Math.max(0, (_chat | 0) + (_inbox | 0));
  if (total === _lastApplied) return;
  _lastApplied = total;
  try {
    if (typeof document !== 'undefined') {
      const cap = total > 99 ? '99+' : String(total);
      document.title = total > 0 ? `(${cap}) ${BASE_TITLE}` : BASE_TITLE;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function') {
      if (total > 0) {
        navigator.setAppBadge(total).catch(() => {});
      } else if (typeof navigator.clearAppBadge === 'function') {
        navigator.clearAppBadge().catch(() => {});
      }
    }
  } catch {}
}

export function setChatUnread(n) {
  _chat = Math.max(0, Number(n) || 0);
  _scheduleApply();
}

export function setInboxUnread(n) {
  _inbox = Math.max(0, Number(n) || 0);
  _scheduleApply();
}

export function clearAll() {
  _chat = 0;
  _inbox = 0;
  _scheduleApply();
}

export function getTotalUnread() {
  return Math.max(0, (_chat | 0) + (_inbox | 0));
}
