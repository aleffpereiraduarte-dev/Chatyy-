// [2026-10-17 smart-storage] Sheet global de oferta de armazenamento, montado
// uma vez no app/_layout (overlay "Late"). Ouve services/storageOffers:
//   kind 'quota'  → envio/backup bloqueado por falta de espaço
//   kind 'backup' → backup de fotos ligado e a biblioteca não cabe no espaço livre
// Sheet do sistema (NativeSheetDialog) no celular; Modal só na web. A loja
// abre DEPOIS do sheet descer, na tela do plano (/settings-one?offer=<tier>),
// então nunca há Modal empilhado sobre Modal no iOS.
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import NativeSheetDialog from '../NativeSheetDialog';
import { runAfterNativeSheet } from '../NativeSheet';
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

  useEffect(() => subscribeOffers((e) => {
    setPlan(getCachedPlanState());
    setEv(e);
    loadPlanState({ force: true }).then((p) => { if (p) setPlan(p); }).catch(() => {});
  }), []);

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
