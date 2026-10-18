// [2026-10-17 smart-storage] Sheet global de oferta de armazenamento, montado
// uma vez no app/_layout (overlay "Late"). Ouve services/storageOffers:
//   kind 'quota'  → envio/backup bloqueado por falta de espaço
//   kind 'backup' → backup de fotos ligado e a biblioteca não cabe no espaço livre
// Sheet do sistema (NativeSheetDialog) no celular; Modal só na web. A loja
// abre DEPOIS do sheet descer, na tela do plano (/settings-one?offer=<tier>),
// então nunca há Modal empilhado sobre Modal no iOS.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AppState, Platform } from 'react-native';
import { router } from 'expo-router';
import NativeSheetDialog from '../NativeSheetDialog';
import { runAfterNativeSheet, nativeSheetsOpenCount, nativeSheetRecentlyClosed } from '../NativeSheet';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconCloud, IconCloudUpload } from '../Icons';
import { subscribeOffers, recommendTier, formatGbShort, offerHref } from '../../services/storageOffers';
import { loadPlanState, getCachedPlanState } from '../../services/planState';
import { MONETIZATION_ENABLED } from '../../constants/featureFlags';
import StorageMeter, { fmtBytes } from './StorageMeter';

export default function StorageOfferHost() {
  const { colors = {}, isDark } = useTheme() || {};
  const { t } = useLanguage();
  const [ev, setEv] = useState(null);
  const [plan, setPlan] = useState(null);

  // [2026-10-17 p2] a oferta nasce de falhas em 2º plano (upload/backup) em
  // QUALQUER tela. Abrir a folha com outro Modal/folha na tela = Modal sobre
  // Modal no iOS (pode derrubar o outro), e com o app em 2º plano o present é
  // recusado. Então só abre com o app ativo e nada aberto; senão fica UMA
  // pendente (a mais recente) e sai no próximo momento livre, uma vez.
  const pendingRef = useRef(null);
  const evRef = useRef(null);
  evRef.current = ev;
  useEffect(() => {
    let timer = null;
    const busy = () => {
      if (evRef.current) return true;
      try { if (AppState.currentState && AppState.currentState !== 'active') return true; } catch {}
      try { if (nativeSheetsOpenCount() > 0 || nativeSheetRecentlyClosed()) return true; } catch {}
      if (Platform.OS === 'ios') {
        try { if (require('../../services/modalGuardIOS').getOpenModals().length > 0) return true; } catch {}
      }
      return false;
    };
    const show = (e) => {
      setPlan(getCachedPlanState());
      setEv(e);
      loadPlanState({ force: true }).then((p) => { if (p) setPlan(p); }).catch(() => {});
    };
    const flush = () => {
      timer = null;
      const p = pendingRef.current;
      if (!p) return;
      if (Date.now() - p.at > 30 * 60 * 1000) { pendingRef.current = null; return; } // velha demais
      if (busy()) { timer = setTimeout(flush, 1500); return; }
      pendingRef.current = null;
      show(p.e);
    };
    const unsub = subscribeOffers((e) => {
      if (evRef.current) return; // já está na tela
      if (!busy()) { pendingRef.current = null; show(e); return; }
      pendingRef.current = { e, at: Date.now() };
      if (!timer) timer = setTimeout(flush, 1500);
    });
    let appSub = null;
    try {
      appSub = AppState.addEventListener('change', (s) => {
        if (s === 'active' && pendingRef.current) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(flush, 800);
        }
      });
    } catch {}
    return () => {
      try { unsub && unsub(); } catch {}
      try { appSub && appSub.remove(); } catch {}
      if (timer) clearTimeout(timer);
    };
  }, []);

  const close = () => setEv(null);
  const visible = !!ev;
  const text = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const sub = colors.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const bg = isDark ? '#1C1C1E' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(60,60,67,0.16)';
  const onInk = isDark ? '#000000' : '#FFFFFF';

  const isBackup = ev?.kind === 'backup';
  const rec = !MONETIZATION_ENABLED ? null
    : (isBackup ? (ev?.rec || recommendTier(plan, { extraBytes: ev?.needBytes || 0 })) : recommendTier(plan));
  const title = isBackup
    ? t('storageOffer.backupTitle', { size: formatGbShort(ev?.needBytes || 0) })
    : t('storageOffer.quotaTitle');
  const body = isBackup
    ? t('storageOffer.backupBody', { free: fmtBytes(ev?.freeBytes || 0) })
    : t('storageOffer.quotaBody');
  const recLine = rec ? (rec.tier.priceLabel
    ? t('storageOffer.recWithPrice', { size: formatGbShort(rec.tier.bytes), price: rec.tier.priceLabel })
    : t('storageOffer.recNoPrice', { size: formatGbShort(rec.tier.bytes) })) : '';

  const go = (href) => { close(); runAfterNativeSheet(() => { try { router.push(href); } catch {} }); };
  const onCancelUploads = typeof ev?.onCancelUploads === 'function' ? ev.onCancelUploads : null;
  const Icon = isBackup ? IconCloudUpload : IconCloud;

  return (
    <NativeSheetDialog
      visible={visible}
      onClose={close}
      panelStyle={[st.panel, { backgroundColor: bg }]}
      overlayStyle={st.overlay}
      animationType="slide"
    >
      {visible ? (
        <View testID="storage-offer-sheet">
          <View style={[st.icon, { backgroundColor: text }]}><Icon size={24} color={onInk} /></View>
          <Text style={[st.title, { color: text }]}>{title}</Text>
          <Text style={[st.body, { color: sub }]}>{body}</Text>
          {plan ? <StorageMeter style={{ marginTop: 16 }} legend="dots" /> : null}
          {recLine ? <Text style={[st.rec, { color: text }]}>{recLine}</Text> : null}
          <View style={{ marginTop: 18, gap: 10 }}>
            {rec ? (
              <Pressable onPress={() => go(offerHref(rec.tier.id))} style={[st.btn, { backgroundColor: text }]} accessibilityRole="button" testID="storage-offer-upgrade">
                <Text style={[st.btnTxt, { color: onInk }]}>{t('storageOffer.getSize', { size: formatGbShort(rec.tier.bytes) })}</Text>
              </Pressable>
            ) : null}
            {!isBackup ? (
              <Pressable onPress={() => go('/manage-storage')} style={[st.btn, { borderWidth: 1, borderColor: border }]} accessibilityRole="button" testID="storage-offer-free">
                <Text style={[st.btnTxt, { color: text }]}>{t('storageOffer.freeSpace')}</Text>
              </Pressable>
            ) : null}
            {onCancelUploads ? (
              <Pressable onPress={() => { try { onCancelUploads(); } catch {} close(); }} style={st.link} accessibilityRole="button" testID="storage-offer-cancel-uploads">
                <Text style={[st.linkTxt, { color: sub }]}>{t('drive.cancelUploads') || 'Cancelar envios'}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={close} style={st.link} accessibilityRole="button" testID="storage-offer-later">
                <Text style={[st.linkTxt, { color: sub }]}>{t('storageOffer.dismiss')}</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
    </NativeSheetDialog>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'stretch' },
  panel: { width: '100%', maxWidth: 520, alignSelf: 'center', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 28 },
  icon: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 25 },
  body: { fontSize: 14.5, lineHeight: 20, marginTop: 6 },
  rec: { fontSize: 14.5, lineHeight: 20, marginTop: 14, fontWeight: '600' },
  btn: { minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnTxt: { fontSize: 16, fontWeight: '600' },
  link: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  linkTxt: { fontSize: 15, fontWeight: '500' },
});
