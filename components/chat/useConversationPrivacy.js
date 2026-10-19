// components/chat/useConversationPrivacy.js — [2026-10-14 adv-privacy]
// Tudo da "Privacidade avançada da conversa" para a tela da conversa, num hook
// só (o app/chat-conversation.js é enorme — lá ficam só chamadas pontuais):
//   const advPriv = useConversationPrivacy({ conversationId, conversationType, isAdmin, currentEmail, colors, isDark, t });
//   advPriv.enabled / advPriv.canEdit / advPriv.openSheet() / advPriv.guard('export'|'ai'|'forward')
//   advPriv.captureProtected → <ChatyySecureView enabled> (privacidade avançada | vanishActive | ajuste global)
//   {advPriv.banner} {advPriv.watermark} {advPriv.sheet}
// Proteção (só com a tela em foco): Android FLAG_SECURE; iOS escudo na gravação
// + aviso de print; web sem clique direito/arrastar + marca d'água.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, Platform, StyleSheet } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { IconShield } from '../Icons';
import AdvancedPrivacySheet from './AdvancedPrivacySheet';
import {
  useAdvancedPrivacy, fetchAdvancedPrivacy, setAdvancedPrivacyRemote,
  acquireCaptureProtection, addScreenshotListener, sendScreenshotNotice, markProtectedOpen,
} from '../../services/chatPrivacy';
import { useCaptureBlockGlobal, setCaptureScope, secureViewAvailable } from '../../services/captureBlock'; // [2026-10-19 secure-view]

function _tt(t, key, fb) {
  try {
    const v = typeof t === 'function' ? t(key) : '';
    return typeof v === 'string' && v && v !== key ? v : fb;
  } catch { return fb; }
}

function _alert(title, msg) {
  try {
    if (Platform.OS === 'web') { window.alert?.(msg || title); return; }
    require('react-native').Alert.alert(title, msg);
  } catch {}
}

function _realConvId(cid) {
  const n = Number(cid);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function viewerHandle(email) {
  const e = String(email || '').trim();
  if (!e) return '';
  return '@' + e.split('@')[0];
}

/** Marca d'água leve (web) — padrão repetido com o @ de quem está vendo. */
export function PrivacyWatermark({ handle, label, dark, style }) {
  const text = `${label || 'Protegido'} · ${handle || ''}`.trim();
  const rows = useMemo(() => Array.from({ length: 9 }), []);
  const cols = useMemo(() => Array.from({ length: 4 }), []);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden', zIndex: 5 }, style]}>
      {rows.map((_, r) => (
        <View key={r} style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: r === 0 ? 40 : 70, transform: [{ rotate: '-18deg' }] }}>
          {cols.map((__, c) => (
            <Text key={c} selectable={false} style={{ color: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)', fontSize: 13, fontWeight: '600', userSelect: 'none' }}>
              {text}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export default function useConversationPrivacy({ conversationId, conversationType, isAdmin, currentEmail, colors, isDark, t, vanishActive }) {
  const cid = _realConvId(conversationId);
  const st = useAdvancedPrivacy(cid || null);
  const enabled = !!cid && st.enabled;
  // [2026-10-19 secure-view] Proteção de captura da conversa = privacidade
  // avançada OU modo temporário OU o ajuste global "Bloquear capturas de tela
  // nas conversas" (de quem está vendo). iOS: <ChatyySecureView> → o print sai
  // "Captura de tela bloqueada"; Android: FLAG_SECURE.
  const globalBlock = useCaptureBlockGlobal();
  const vanishOn = !!vanishActive;
  const globalOn = !!globalBlock && !enabled && !vanishOn;
  const captureProtected = enabled || vanishOn || !!globalBlock;
  const screenshotNotice = st.screenshotNotice !== false;
  const isGroupish = conversationType === 'group' || conversationType === 'channel';
  const canEdit = !!cid && conversationType !== 'saved' && (!isGroupish || !!isAdmin);
  const focused = useIsFocused();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Proteção de captura enquanto a conversa protegida está em foco.
  useEffect(() => {
    if (!enabled || !focused || !cid) return undefined;
    markProtectedOpen(cid, true);
    if (Platform.OS === 'web') {
      if (typeof document === 'undefined') return () => markProtectedOpen(cid, false);
      const editable = (el) => {
        try {
          const tg = el && el.tagName;
          return tg === 'INPUT' || tg === 'TEXTAREA' || (el && el.isContentEditable);
        } catch { return false; }
      };
      // Bloqueia só o menu NATIVO (Salvar imagem como…); menus do app (onContextMenu
      // do React) continuam funcionando.
      const onCtx = (e) => { if (!editable(e.target)) { try { e.preventDefault(); } catch {} } };
      const onDrag = (e) => {
        try {
          const tg = e.target && e.target.tagName;
          if (tg === 'IMG' || tg === 'VIDEO' || tg === 'AUDIO' || tg === 'A') e.preventDefault();
        } catch {}
      };
      document.addEventListener('contextmenu', onCtx, true);
      document.addEventListener('dragstart', onDrag, true);
      return () => {
        document.removeEventListener('contextmenu', onCtx, true);
        document.removeEventListener('dragstart', onDrag, true);
        markProtectedOpen(cid, false);
      };
    }
    const release = acquireCaptureProtection(`chatyy-advpriv-conv-${cid}`, {
      labels: {
        title: _tt(t, 'advPriv.protectedTitle', 'Conteúdo protegido'),
        subtitle: _tt(t, 'advPriv.protectedRecording', 'A gravação ou o espelhamento de tela está ativo.'),
      },
      secureView: true,
    });
    // iOS: o print sai "Captura de tela bloqueada" (binário novo) ou com o
    // conteúdo (antigo) — nos dois casos a conversa é avisada. Android:
    // FLAG_SECURE já bloqueia (print sai preto / o SO recusa).
    let sub = null;
    if (Platform.OS === 'ios' && screenshotNotice) {
      sub = addScreenshotListener(() => sendScreenshotNotice(cid, { kind: 'screenshot', blocked: secureViewAvailable(), scope: 'adv' }));
    }
    return () => {
      try { release(); } catch {}
      try { sub && sub.remove(); } catch {}
      markProtectedOpen(cid, false);
    };
  }, [enabled, focused, cid, screenshotNotice, t]);

  // [2026-10-19 secure-view] Ajuste global: protege toda conversa em foco
  // (Android FLAG_SECURE; iOS sem a view nativa = escudo na gravação) e avisa
  // a conversa do print (iOS). Privacidade avançada / modo temporário já
  // cuidam disso nos efeitos deles.
  useEffect(() => {
    if (!globalOn || !focused || Platform.OS === 'web') return undefined;
    const tag = `chatyy-capblock-conv-${cid || 'new'}`;
    const release = acquireCaptureProtection(tag, {
      labels: {
        title: _tt(t, 'advPriv.protectedTitle', 'Conteúdo protegido'),
        subtitle: _tt(t, 'advPriv.protectedRecording', 'A gravação ou o espelhamento de tela está ativo.'),
      },
      secureView: true,
    });
    let sub = null;
    if (Platform.OS === 'ios' && cid && conversationType !== 'saved') {
      sub = addScreenshotListener(() => sendScreenshotNotice(cid, { kind: 'screenshot', blocked: secureViewAvailable(), scope: 'global' }));
    }
    return () => {
      try { release(); } catch {}
      try { sub && sub.remove(); } catch {}
    };
  }, [globalOn, focused, cid, conversationType, t]);

  // Escopo aberto (independe do foco): Dados do contato / visualizador
  // empurrados por cima desta conversa também protegem.
  useEffect(() => {
    if (!cid) return undefined;
    const reasons = [];
    if (enabled) reasons.push('adv');
    if (vanishOn) reasons.push('vanish');
    if (globalBlock) reasons.push('global');
    for (const r of reasons) setCaptureScope(cid, true, r);
    return () => { for (const r of reasons) setCaptureScope(cid, false, r); };
  }, [cid, enabled, vanishOn, globalBlock]);

  const openSheet = useCallback(() => {
    if (!cid) return;
    setSheetOpen(true);
    fetchAdvancedPrivacy(cid).catch?.(() => {});
  }, [cid]);

  const _apply = useCallback(async (nextEnabled, nextNotice) => {
    if (!cid || !canEdit || busy) return;
    setBusy(true);
    const r = await setAdvancedPrivacyRemote(cid, nextEnabled, nextNotice);
    setBusy(false);
    if (!r.ok) {
      _alert(_tt(t, 'advPriv.title', 'Privacidade avançada da conversa'), r.error && /admin/i.test(r.error)
        ? _tt(t, 'advPriv.adminOnly', 'Só administradores do grupo podem alterar.')
        : _tt(t, 'advPriv.errorSave', 'Não foi possível alterar agora. Tente de novo.'));
    }
  }, [cid, canEdit, busy, t]);

  /** true = bloqueado (já avisou o usuário). kind: 'export' | 'ai' | 'forward'. */
  const guard = useCallback((kind) => {
    if (!enabled) return false;
    const msg = kind === 'export'
      ? _tt(t, 'advPriv.exportBlocked', 'A exportação está desativada nesta conversa (privacidade avançada).')
      : kind === 'ai'
        ? _tt(t, 'advPriv.aiBlocked', 'A Bia não pode ler esta conversa (privacidade avançada).')
        : _tt(t, 'advPriv.forwardBlocked', 'As mídias desta conversa não podem ser encaminhadas nem salvas (privacidade avançada).');
    _alert(_tt(t, 'advPriv.short', 'Privacidade avançada'), msg);
    return true;
  }, [enabled, t]);

  const fg = (colors && colors.text) || (isDark ? '#F1F3F5' : '#111111');
  const sub = (colors && colors.textSecondary) || (isDark ? '#A1A1AA' : '#555555');

  const banner = enabled ? (
    <Pressable
      onPress={openSheet}
      accessibilityRole="button"
      accessibilityLabel={_tt(t, 'advPriv.bannerOn', 'Privacidade avançada ativada')}
      style={[styles.banner, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)' }]}
    >
      <IconShield size={13} color={fg} />
      <Text style={[styles.bannerText, { color: sub }]} numberOfLines={1}>{_tt(t, 'advPriv.bannerOn', 'Privacidade avançada ativada')}</Text>
    </Pressable>
  ) : null;

  const watermark = enabled && Platform.OS === 'web' ? (
    <PrivacyWatermark handle={viewerHandle(currentEmail)} label={_tt(t, 'advPriv.watermark', 'Protegido')} dark={!!isDark} />
  ) : null;

  const sheet = cid ? (
    <AdvancedPrivacySheet
      visible={sheetOpen}
      onClose={() => setSheetOpen(false)}
      enabled={enabled}
      screenshotNotice={screenshotNotice}
      canEdit={canEdit}
      busy={busy}
      onToggle={(v) => _apply(!!v, screenshotNotice)}
      onToggleScreenshot={(v) => _apply(true, !!v)}
      colors={colors}
      isDark={isDark}
      t={t}
    />
  ) : null;

  const statusLabel = enabled ? _tt(t, 'advPriv.on', 'Ativada') : _tt(t, 'advPriv.off', 'Desativada');

  return { enabled, screenshotNotice, canEdit, openSheet, guard, banner, watermark, sheet, statusLabel, captureProtected };
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    alignSelf: 'center', marginTop: 6, marginBottom: 2, paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, maxWidth: '92%',
  },
  bannerText: { fontSize: 12.5, fontWeight: '500' },
});
