// components/calls/MyCallLinksSheet.js — [2026-10-16 wave12-D] "Meus links de chamada".
//
// Lista os links criados neste aparelho (components/calls/myCallLinks.js —
// cache por conta; o servidor ainda não lista links do criador), com data,
// estado (ativo / expirado / revogado), copiar, compartilhar e revogar
// (confirmação INLINE P&B na própria linha).
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Share, Text, View } from 'react-native';
import Sheet, { useOverlayColors } from '../ui/Sheet';
import { IconCopy, IconLink, IconPhone, IconShare, IconTrash, IconVideo, IconX } from '../Icons';
import { showToast } from '../ui/Toast';
import {
  useMyCallLinks, refreshMyCallLinks, patchMyCallLink, removeMyCallLink, callLinkState,
} from './myCallLinks';
import { buildCallLinkMessage } from './callLinkUtil';

function tr(t, key, fb, params) {
  let v;
  try { v = t?.(key, params); } catch {}
  if (v && v !== key) return v;
  let s = fb;
  if (params) Object.keys(params).forEach((k) => { s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k])); });
  return s;
}

function fmtDate(ms, language) {
  try {
    return new Date(ms).toLocaleString(language || undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
}

async function copyText(text) {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const Clipboard = require('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch { return false; }
}

function IconBtn({ onPress, label, children, oc, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
        backgroundColor: oc.neutralButton,
        opacity: disabled ? 0.4 : (pressed ? 0.6 : 1),
      })}
    >
      {children}
    </Pressable>
  );
}

const LinkRow = function LinkRow({ link, t, language, oc, ink, sub, onCopy, onShare, onRevoke, onRemove, busy, confirming, failed, onAskRevoke, onCancelRevoke }) {
  const state = callLinkState(link);
  const active = state === 'active';
  const KindIcon = link.is_video ? IconVideo : IconPhone;
  // [call-link 2026-10-19] nome dado na criação; válido até revogar ou 90 dias sem uso.
  const title = String(link.title || '').trim()
    || (link.is_video ? tr(t, 'calls.linkVideo', 'Link de vídeo') : tr(t, 'calls.linkVoice', 'Link de voz'));
  const statusText = state === 'revoked'
    ? tr(t, 'calls.linkRevoked', 'Revogado')
    : state === 'expired'
      ? tr(t, 'calls.linkExpired', 'Expirado')
      : link.idle_expiry
        ? (link.last_used_at
          ? tr(t, 'callLink.lastUsed', 'Ativo · último uso {date}', { date: fmtDate(link.last_used_at, language) })
          : tr(t, 'callLink.activeUntilRevoked', 'Ativo até você revogar'))
        : tr(t, 'calls.linkExpiresAt', 'Expira {date}', { date: fmtDate(link.expires_at, language) });
  return (
    <View>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 }}>
      <View style={{
        width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: oc.neutralButton,
        opacity: active ? 1 : 0.5,
      }}>
        <KindIcon size={19} color={ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: active ? ink : sub }}>{title}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12.5, color: sub, marginTop: 2 }} selectable>
          {String(link.url || '').replace(/^https?:\/\//, '')}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12.5, color: sub, marginTop: 1 }}>
          {tr(t, 'calls.linkCreatedAt', 'Criado {date}', { date: fmtDate(link.created_at, language) })}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12.5, marginTop: 1, color: active ? sub : ink, fontWeight: active ? '400' : '600' }}>
          {statusText}
        </Text>
      </View>
      {active ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconBtn oc={oc} label={tr(t, 'common.copy', 'Copiar')} onPress={() => onCopy(link)}>
            <IconCopy size={17} color={ink} />
          </IconBtn>
          <IconBtn oc={oc} label={tr(t, 'common.share', 'Compartilhar')} onPress={() => onShare(link)}>
            <IconShare size={17} color={ink} />
          </IconBtn>
          <IconBtn oc={oc} label={tr(t, 'calls.linkRevoke', 'Revogar')} onPress={() => onAskRevoke(link)} disabled={busy}>
            {busy ? <ActivityIndicator size="small" color={ink} /> : <IconTrash size={17} color={ink} />}
          </IconBtn>
        </View>
      ) : (
        <IconBtn oc={oc} label={tr(t, 'common.remove', 'Remover')} onPress={() => onRemove(link)}>
          <IconX size={17} color={sub} />
        </IconBtn>
      )}
    </View>
    {confirming && active && (
      // Confirmação INLINE (P&B): um diálogo global abriria por trás desta folha no web.
      <View style={{ paddingBottom: 12, gap: 10 }} testID="call-link-revoke-confirm">
        <Text style={{ fontSize: 15, fontWeight: '600', color: ink }}>{tr(t, 'calls.linkRevokeTitle', 'Revogar link?')}</Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: sub }}>
          {tr(t, 'calls.linkRevokeMsg', 'Quem tiver o link não conseguirá mais entrar na chamada.')}
        </Text>
        {failed && (
          <Text style={{ fontSize: 13, fontWeight: '600', color: oc.danger }}>
            {tr(t, 'calls.linkRevokeFailed', 'Não foi possível revogar o link. Tente novamente.')}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable onPress={onCancelRevoke} accessibilityRole="button"
            style={({ pressed }) => ({ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: oc.neutralButton, opacity: pressed ? 0.7 : 1 })}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: ink }}>{tr(t, 'common.cancel', 'Cancelar')}</Text>
          </Pressable>
          <Pressable onPress={() => onRevoke(link)} disabled={busy} accessibilityRole="button" testID="call-link-revoke-yes"
            style={({ pressed }) => ({ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: oc.primaryButton, opacity: busy ? 0.6 : (pressed ? 0.8 : 1) })}>
            {busy ? <ActivityIndicator size="small" color={oc.onPrimaryButton} />
              : <Text style={{ fontSize: 15, fontWeight: '600', color: oc.onPrimaryButton }}>{tr(t, 'calls.linkRevoke', 'Revogar')}</Text>}
          </Pressable>
        </View>
      </View>
    )}
    </View>
  );
};

export default function MyCallLinksSheet({ visible, onClose, t, language }) {
  const oc = useOverlayColors();
  const links = useMyCallLinks();
  const [busyId, setBusyId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [failId, setFailId] = useState(null);
  const ink = oc.text;
  const sub = oc.textSecondary;

  useEffect(() => { if (visible) refreshMyCallLinks(); else { setConfirmId(null); setFailId(null); } }, [visible]);

  const onCopy = useCallback(async (link) => {
    const ok = await copyText(link.url);
    if (ok) showToast({ message: tr(t, 'calls.linkCopied', 'Link copiado'), kind: 'success' });
  }, [t]);

  const onShare = useCallback(async (link) => {
    const message = buildCallLinkMessage(link, t); // [call-link 2026-10-19] mesmo texto do cartão no chat
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ text: message, url: link.url }); return; }
        const ok = await copyText(link.url);
        if (ok) showToast({ message: tr(t, 'calls.linkCopied', 'Link copiado'), kind: 'success' });
        return;
      }
      await Share.share(Platform.OS === 'ios' ? { message } : { message, url: link.url }); // iOS: url junto duplica o link
    } catch {}
  }, [t]);

  const onRevoke = useCallback(async (link) => {
    setBusyId(link.link_id);
    setFailId(null);
    try {
      const r = await require('../../services/api').chatCallLinkRevoke(link.link_id);
      const msg = String(r?.message || '');
      if (r && r.success === false && !/not found/i.test(msg)) throw new Error(msg || 'revoke_failed');
      patchMyCallLink(link.link_id, { revoked: true, revoked_at: Date.now() });
      setConfirmId(null);
      showToast({ message: tr(t, 'calls.linkRevoked', 'Revogado'), kind: 'success' });
    } catch {
      setFailId(link.link_id); // erro INLINE (diálogo/toast global ficaria atrás da folha no web)
    } finally {
      setBusyId(null);
    }
  }, [t]);

  const onRemove = useCallback((link) => removeMyCallLink(link.link_id), []);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={tr(t, 'calls.myCallLinks', 'Meus links de chamada')}
      subtitle={tr(t, 'calls.myCallLinksHint', 'Os links valem até você revogar ou ficarem 90 dias sem uso.')}
      scroll
      testID="my-call-links-sheet"
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
        {links.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 28, gap: 10 }}>
            <IconLink size={28} color={sub} />
            <Text style={{ fontSize: 14, color: sub, textAlign: 'center' }}>
              {tr(t, 'calls.myCallLinksEmpty', 'Nenhum link criado neste aparelho')}
            </Text>
          </View>
        ) : links.map((l, i) => (
          <View key={l.link_id} style={i > 0 ? { borderTopWidth: 0.5, borderTopColor: oc.separator } : null}>
            <LinkRow
              link={l} t={t} language={language} oc={oc} ink={ink} sub={sub}
              onCopy={onCopy} onShare={onShare} onRevoke={onRevoke} onRemove={onRemove}
              busy={busyId === l.link_id}
              confirming={confirmId === l.link_id}
              failed={failId === l.link_id}
              onAskRevoke={(x) => setConfirmId(x.link_id)}
              onCancelRevoke={() => { setConfirmId(null); setFailId(null); }}
            />
          </View>
        ))}
      </View>
    </Sheet>
  );
}
