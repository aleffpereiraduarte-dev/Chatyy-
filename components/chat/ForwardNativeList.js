// components/chat/ForwardNativeList.js — [2026-10-18 fwd-native]
//
// Lista do "Encaminhar para" em NATIVO (ChatyyContactList, apiVersion >= 2):
// virtualizada (UICollectionView / RecyclerView), seções "Recentes" / "Todas
// conversas" / "Resultados", check animado + haptic no toque. Acima dela, a
// fileira NATIVA de selecionados (ChatyyChipStrip) — toque no chip desmarca.
//
// A conversa continua dona do estado (forwardSelected, limite de 5, envio):
// este componente só desenha `recents` / `rest` já filtrados e devolve
// onToggle(convId). Qualquer falha → onFailure() e a folha volta à lista JS.
//
// Desligar (OTA/console): globalThis.__chatyy_native_forward = false
import React, { useMemo } from 'react';
import { Platform, View } from 'react-native';
import NativeContactList from '../contacts/NativeContactList';
import NativeChipStrip from '../groupCreate/NativeChipStrip';
import { buildFlatRows, contactTile } from '../contacts/contactListAdapter';
import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

/** Liga o seletor nativo? (binário + kill switch + não falhou nesta sessão). */
export function nativeForwardEnabled() {
  if (Platform.OS === 'web') return false;
  try {
    if (globalThis.__chatyy_native_forward === false) return false;
    if (globalThis.__chatyy_native_forward_failed) return false;
    const m = require('../../modules/expo-chat-conversation-list');
    if (!(m.contactListApiVersion && m.contactListApiVersion() >= 2)) return false;
    return !!(m.getNativeContactListView && m.getNativeContactListView());
  } catch { return false; }
}

/** Chips só quando a view existe no binário (senão o título "3/5" basta). */
function chipsAvailable() {
  try {
    const m = require('../../modules/expo-chat-conversation-list');
    return !!(m.getNativeChipStripView && m.getNativeChipStripView());
  } catch { return false; }
}

export function markNativeForwardFailed(msg) {
  try {
    globalThis.__chatyy_native_forward_failed = true;
    console.warn('[native-forward] fallback JS:', msg);
    require('../../services/crashReporter').reportNativeFallback('native_forward', String(msg || ''));
  } catch {}
}

/** Nome + prévia iguais aos da linha JS (apelido, "Mensagens salvas", prévia da lista). */
function describeConv(item, currentEmail, t) {
  const me = String(currentEmail || '').toLowerCase();
  const peerEmail = item.type === 'direct'
    ? (item.other_email || item.contact_email || item.members?.find(m => m.email !== currentEmail)?.email || item.email || '')
    : '';
  const isSaved = item.type === 'saved' || (!!peerEmail && !!me && String(peerEmail).toLowerCase() === me);
  let nick = '';
  if (peerEmail && !isSaved) { try { nick = require('../../services/nicknames').getNickname(peerEmail) || ''; } catch {} }
  let pretty = '';
  try { pretty = require('../../services/api').emailToDisplayName(item.display_name || item.name || peerEmail || '') || ''; } catch { pretty = String(item.display_name || item.name || peerEmail || ''); }
  const name = isSaved ? (t('chat.savedMessages') || '') : (nick || pretty || t('chat.unknown') || '');
  let preview = '';
  try {
    const CL = require('../ChatListTab');
    const r = item.last_message ? CL.computeRowPreview(item.last_message, item.type === 'group', item.type === 'channel', me, t, item.members) : null;
    if (r && r.preview) preview = (r.previewSender ? `${r.previewSender}: ` : '') + String(r.preview);
  } catch {}
  if (!preview && item.type === 'group') preview = `${item.member_count || item.members?.length || 0} ${t('chat.members') || 'membros'}`;
  return { name, peerEmail: isSaved ? (currentEmail || peerEmail) : peerEmail, preview };
}

const _isUrl = (u) => typeof u === 'string' && /^(https?:|file:|data:image)/i.test(u);

/**
 * Props:
 *   recents, rest      conversas já filtradas (mesma regra da lista JS)
 *   query              termo (muda o título da 2ª seção)
 *   selected           Set<string> de ids marcados
 *   currentEmail       conta ativa (nome "Mensagens salvas", peer do direct)
 *   lookup(id)         conversa por id (chip de algo fora do filtro atual)
 *   empty              nó RN mostrado quando não há linhas
 *   onToggle(convId), onFailure(msg), colors, isDark, t, bottomInset
 */
export default function ForwardNativeList(props) {
  const { recents, rest, query, selected, currentEmail, onToggle, onFailure, colors, isDark, t, bottomInset = 12 } = props;
  const q = String(query || '').trim();

  // Cache por objeto de conversa (a conversa re-renderiza muito com a folha aberta).
  const descCache = useMemo(() => new WeakMap(), [currentEmail, t]);
  const descOf = (c) => {
    let d = descCache.get(c);
    if (!d) {
      try { d = describeConv(c, currentEmail, t) || {}; } catch { d = {}; }
      descCache.set(c, d);
    }
    return d;
  };

  const sections = useMemo(() => {
    const out = [];
    if (!q && recents && recents.length) out.push({ key: 'recent', title: t('chatConv.recents') || 'Recentes', data: recents });
    if (rest && rest.length) out.push({ key: q ? 'res' : 'all', title: q ? (t('chat.searchResults') || 'Resultados') : (t('chat.allConversations') || 'Todas conversas'), data: rest });
    return out;
  }, [recents, rest, q, t]);

  const titleColor = colors.textSecondary;
  const { rows, meta } = useMemo(() => buildFlatRows(
    sections,
    (sec) => ({
      t: String(sec.title || ''), sbg: colors.background, sfg: titleColor,
      up: true, fs: 12, fw: 600, ls: 0.5, pt: sec.key === 'recent' ? 12 : 16, pb: 6, ph: 14,
    }),
    (item) => {
      if (!item || item.id == null) return null;
      const d = descOf(item);
      const name = String(d.name || '');
      const tiles = _isUrl(item.avatar_url)
        ? [{ u: item.avatar_url, i: initialsOf(name, d.peerEmail || ''), g: gradientIndex(name || String(item.id)) }]
        : contactTile(d.peerEmail || '', name || 'C');
      const isSel = selected && selected.has(String(item.id));
      return { key: String(item.id), row: {
        t: name, tw: 500,
        sb: String(d.preview || ''), sbt: 1,
        tiles, av: 42,
        ck: isSel ? 2 : 1,
        a11y: name,
      } };
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [sections, selected, colors.background, titleColor, descCache]);

  const chips = useMemo(() => {
    if (!selected || !selected.size) return [];
    const all = [...(recents || []), ...(rest || [])];
    const byId = new Map(all.map(c => [String(c.id), c]));
    const out = [];
    for (const id of selected) {
      const c = byId.get(id) || (props.lookup ? props.lookup(id) : null);
      if (!c) continue;
      const d = descOf(c);
      const name = String(d.name || '');
      out.push({
        id, email: id, name,
        tiles: _isUrl(c.avatar_url)
          ? [{ u: c.avatar_url, i: initialsOf(name, d.peerEmail || ''), g: gradientIndex(name || id) }]
          : contactTile(d.peerEmail || '', name || 'C'),
      });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, recents, rest, descCache]);

  const nColors = useMemo(() => ({
    dark: !!isDark,
    bg: colors.background, text: colors.text, sub: colors.textSecondary, faint: colors.textTertiary,
    hair: colors.border, primary: colors.primary, onPrimary: colors.onPrimary || '#fff',
    warning: colors.warning, error: colors.error,
    press: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)',
    border: colors.border, indexText: colors.primary,
  }), [colors, isDark]);
  const metrics = useMemo(() => ({
    padH: 14, padV: 10, gap: 12, minH: 0,
    nameSize: 15, subSize: 13, sub2Size: 12, metaSize: 10,
  }), []);

  const showChips = chipsAvailable();
  return (
    <View collapsable={false} style={{ flex: 1 }}>
      {showChips ? (
        <NativeChipStrip
          members={chips}
          colors={colors}
          isDark={isDark}
          borderColor={colors.border}
          removeLabel={t('common.remove') || 'Remover'}
          onRemove={(id) => { try { onToggle(id); } catch {} }}
          onFailure={() => { /* sem chips: o título "N/5" continua */ }}
        />
      ) : null}
      <NativeContactList
        rows={rows}
        meta={meta}
        colors={nColors}
        metrics={metrics}
        isDark={isDark}
        indexEnabled={false}
        swipeEnabled={false}
        bottomInset={bottomInset}
        onPress={(item) => { if (item && item.id != null) onToggle(item.id); }}
        onFailure={onFailure}
        empty={props.empty || null}
      />
    </View>
  );
}
