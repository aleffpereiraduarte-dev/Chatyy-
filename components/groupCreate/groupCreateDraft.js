// components/groupCreate/groupCreateDraft.js — [2026-10-15 native-group-create]
//
// Novo grupo / Nova conversa NATIVOS (nível WhatsApp). Este arquivo guarda:
//   - o kill switch + detecção do binário (nativeGroupCreateEnabled);
//   - o RASCUNHO compartilhado entre as rotas /chat-new?mode=group (seleção de
//     membros) e /group-new-details (foto, nome, descrição, permissões) —
//     duas rotas = push/voltar nativos sem perder a seleção.
//
// Desligar (OTA/console): globalThis.__chatyy_native_group_create = false
// Binário antigo (ChatyyContactList apiVersion < 2 ou sem ChatyyChipStrip /
// ChatyySettingsList) → false e TUDO segue no fluxo JS de antes (inline no
// chat-new + CreateGroupFlow no "+" da lista), idêntico.
import { Platform } from 'react-native';

export const GROUP_MAX_MEMBERS = 1024; // inclui quem cria

export function nativeGroupCreateEnabled() {
  if (Platform.OS === 'web') return false;
  try {
    if (globalThis.__chatyy_native_group_create === false) return false;
    if (globalThis.__chatyy_native_group_create_failed) return false;
    const m = require('../../modules/expo-chat-conversation-list');
    if (!(m.contactListApiVersion && m.contactListApiVersion() >= 2)) return false;
    if (!m.getNativeChipStripView || !m.getNativeChipStripView()) return false;
    if (!m.getNativeSettingsListView || !m.getNativeSettingsListView()) return false;
    return true;
  } catch { return false; }
}

/** Falha nativa nesta sessão → volta ao JS (e reporta). */
export function markNativeGroupCreateFailed(msg) {
  try {
    globalThis.__chatyy_native_group_create_failed = true;
    console.warn('[native-group-create] fallback JS:', msg);
    require('../../services/crashReporter').reportNativeFallback('native_group_create', String(msg || ''));
  } catch {}
}

// ── Rascunho ────────────────────────────────────────────────────────────────
let _draft = { kind: 'group', members: [], at: 0 };

/** kind: 'group' | 'channel'; members: [{ email, name }] */
export function setGroupDraft(kind, members) {
  _draft = {
    kind: kind === 'channel' ? 'channel' : 'group',
    members: Array.isArray(members) ? members.filter(m => m && m.email).map(m => ({ email: m.email, name: m.name || m.email })) : [],
    at: Date.now(),
  };
}

export function getGroupDraft() { return _draft; }

export function clearGroupDraft() { _draft = { kind: 'group', members: [], at: 0 }; }

/**
 * Abre o fluxo NATIVO (lista "+" / estado vazio). false = desligado → o
 * chamador abre o fluxo JS de sempre (CreateGroupFlow).
 *   kind 'group'   → /chat-new?mode=group (seleção de membros)
 *   kind 'channel' → /group-new-details (nome, descrição, foto, público)
 */
export function openNativeGroupCreate(router, kind) {
  if (!router || !nativeGroupCreateEnabled()) return false;
  try {
    if (kind === 'channel') {
      setGroupDraft('channel', []);
      router.push('/group-new-details');
    } else {
      router.push({ pathname: '/chat-new', params: { mode: 'group' } });
    }
    return true;
  } catch { return false; }
}
