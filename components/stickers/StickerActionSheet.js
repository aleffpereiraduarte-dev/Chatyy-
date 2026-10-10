// [2026-10-10 stickers-import] Folha da figurinha (nível WhatsApp).
//
// • StickerActionSheet — tocar numa figurinha RECEBIDA (ou "Figurinha" no menu
//   da mensagem): figurinha grande + "Adicionar às favoritas" (estrela, vai pro
//   seletor), "Salvar nas minhas figurinhas" (cópia no pacote pessoal "Minhas
//   figurinhas", criado se não existir) e — só se o pacote for da loja ou
//   público — "Ver pacote" / "Adicionar pacote". O servidor reconhece a
//   figurinha pela mensagem (message_id) ou pela URL (sticker_lookup) e NUNCA
//   devolve pacote pessoal de outra pessoa: nesse caso só dá pra salvar a cópia.
// • StickerDropSheet — web: arrastar/colar .webp no compositor oferece enviar
//   como figurinha, salvar nas minhas figurinhas ou enviar como foto.
//
// Preto & branco, ícones SVG (sem emoji). Só RN core + expo-image (OTA-safe).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import { IconX, IconStar, IconStarFilled, IconDownload, IconPackage, IconPlus, IconCheck, IconSend, IconImage, IconChevronRight } from '../Icons';

export function stickerAbsUrl(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(https?:|file:|blob:|data:)/i.test(u)) return u;
  if (u.startsWith('/data/')) {
    try { return api.getMediaUrl(u); } catch { return 'https://chatyy.com.br' + u; }
  }
  return u;
}

function _num(id) {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 && String(Math.trunc(n)) === String(id).trim() ? n : null;
}

function Row({ icon: Icon, label, sub, onPress, disabled, busy, colors, right }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[st.row, { borderTopColor: colors.border, opacity: disabled ? 0.45 : 1 }]}
    >
      <View style={[st.rowIcon, { borderColor: colors.border }]}>
        {busy ? <ActivityIndicator size="small" color={colors.text} /> : <Icon size={20} color={colors.text} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{label}</Text>
        {sub ? <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right || null}
    </TouchableOpacity>
  );
}

function SheetFrame({ visible, onClose, children, colors, t }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={st.backdrop} accessibilityLabel={t('common.close')}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[st.sheet, { backgroundColor: colors.background, paddingBottom: Math.max(16, insets.bottom + 8) }]}>
          <View style={[st.grabber, { backgroundColor: colors.border }]} />
          <TouchableOpacity onPress={onClose} hitSlop={10} style={st.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          {children}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

/**
 * props: visible, onClose, messageId (id da mensagem no servidor, opcional),
 *        url (URL da figurinha), onToast?(msg)
 */
export default function StickerActionSheet({ visible, onClose, messageId = null, url = '', onToast }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const reqRef = useRef(0);
  const mid = _num(messageId);

  useEffect(() => {
    if (!visible) return;
    const my = ++reqRef.current;
    setInfo(null); setNote(''); setBusy(''); setLoading(true);
    (async () => {
      try {
        const r = await api.stickerLookup({ messageId: mid, url: mid ? '' : url });
        if (my !== reqRef.current) return;
        setInfo(r?.data || r || null);
      } catch { if (my === reqRef.current) setInfo(null); }
      finally { if (my === reqRef.current) setLoading(false); }
    })();
  }, [visible, mid, url]);

  const say = useCallback((m) => { setNote(m); try { onToast?.(m); } catch {} }, [onToast]);
  const favUrl = (info?.url && /^https?:/i.test(info.url)) ? info.url : (stickerAbsUrl(url) || info?.url || '');

  const toggleFav = useCallback(async () => {
    if (!favUrl) return;
    setBusy('fav');
    try {
      const r = await api.chatStickerFavoriteToggle(favUrl);
      const fav = !!(r?.data?.favorited ?? r?.favorited);
      if (r?.success === false) throw new Error('x');
      setInfo((p) => ({ ...(p || {}), favorited: fav }));
      say(fav ? t('stickers.addedToFavorites') : t('stickers.removedFromFavorites'));
    } catch { say(t('stickers.actionFailed')); }
    finally { setBusy(''); }
  }, [favUrl, say, t]);

  const save = useCallback(async () => {
    setBusy('save');
    try {
      const r = await api.stickerSave({ messageId: mid, url: mid ? '' : url });
      if (r?.success === false) {
        const reason = r?.data?.reason;
        say(reason === 'pack_full' ? t('stickers.packFull') : t('stickers.saveFailed'));
      } else {
        setInfo((p) => ({ ...(p || {}), saved: true }));
        say(r?.data?.already ? t('stickers.alreadySaved') : t('stickers.savedToMine'));
      }
    } catch { say(t('stickers.saveFailed')); }
    finally { setBusy(''); }
  }, [mid, url, say, t]);

  const pack = info?.pack || null;
  const addPack = useCallback(async () => {
    if (!pack) return;
    setBusy('pack');
    try {
      const r = await api.stickerPackInstall(pack.id);
      if (r?.success === false) throw new Error('x');
      setInfo((p) => ({ ...(p || {}), pack: { ...(p?.pack || {}), installed: true } }));
      say(t('stickers.packAdded'));
    } catch { say(t('stickers.actionFailed')); }
    finally { setBusy(''); }
  }, [pack, say, t]);

  const openPack = useCallback(() => {
    if (!pack) return;
    onClose?.();
    setTimeout(() => router.push({ pathname: '/stickers/pack', params: { id: String(pack.id) } }), 50);
  }, [pack, onClose, router]);

  const big = stickerAbsUrl(url || info?.url);
  return (
    <SheetFrame visible={visible} onClose={onClose} colors={colors} t={t}>
      <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 10 }}>
        {big ? (
          <ExpoImage source={{ uri: big }} style={{ width: 200, height: 200 }} contentFit="contain" autoplay accessibilityLabel={t('chat.sticker')} />
        ) : <View style={{ width: 200, height: 200 }} />}
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: 18 }} color={colors.textSecondary} />
      ) : (
        <View>
          <Row
            icon={info?.favorited ? IconStarFilled : IconStar}
            label={info?.favorited ? t('stickers.removeFromFavorites') : t('stickers.addToFavorites')}
            onPress={toggleFav} busy={busy === 'fav'} disabled={!favUrl} colors={colors}
          />
          <Row
            icon={info?.saved ? IconCheck : IconDownload}
            label={info?.saved ? t('stickers.inMyStickers') : t('stickers.saveToMine')}
            sub={info?.found === false ? t('stickers.cantSave') : (info?.is_mine && !info?.saved ? '' : '')}
            onPress={save} busy={busy === 'save'} disabled={!!info?.saved || info?.found === false} colors={colors}
          />
          {pack ? (
            <>
              <Row
                icon={IconPackage}
                label={t('stickers.viewPack')}
                sub={t('stickers.packSummary', { name: pack.name, count: pack.sticker_count || 0 })}
                onPress={openPack} colors={colors}
                right={<IconChevronRight size={18} color={colors.textSecondary} />}
              />
              {!pack.installed && !pack.is_owner ? (
                <Row icon={IconPlus} label={t('stickers.addPack')} onPress={addPack} busy={busy === 'pack'} colors={colors} />
              ) : null}
            </>
          ) : null}
          {note ? <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 12 }}>{note}</Text> : null}
        </View>
      )}
    </SheetFrame>
  );
}

/**
 * Web: arquivos .webp arrastados/colados no compositor.
 * props: visible, files [{uri, blob, name, type, size}], onClose,
 *        onSendSticker(absUrl), onSendAsPhoto(files)
 */
export function StickerDropSheet({ visible, files = [], onClose, onSendSticker, onSendAsPhoto }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (visible) { setBusy(''); setNote(''); } }, [visible]);
  const first = files[0] || null;

  const run = useCallback(async (mode) => {
    if (!files.length) return;
    setBusy(mode); setNote('');
    let ok = 0; let fail = 0; const urls = [];
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.stickerUpload(f.blob || f, { packId: mode === 'send' ? 'none' : null });
      const s = r?.data?.sticker || null;
      if (r?.success && s) { ok++; urls.push(s.abs_url || stickerAbsUrl(s.url)); } else fail++;
    }
    setBusy('');
    if (mode === 'send') {
      for (const u of urls) { try { onSendSticker?.(u); } catch {} }
      if (!fail) { onClose?.(); return; }
    }
    setNote(fail ? t('stickers.someFailed', { ok, fail }) : t('stickers.savedCount', { count: ok }));
    if (!fail && mode === 'save') setTimeout(() => onClose?.(), 900);
  }, [files, onSendSticker, onClose, t]);

  return (
    <SheetFrame visible={visible} onClose={onClose} colors={colors} t={t}>
      <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 10, flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
        {files.slice(0, 4).map((f, i) => (
          <ExpoImage key={i} source={{ uri: f.uri }} style={{ width: files.length > 1 ? 72 : 160, height: files.length > 1 ? 72 : 160 }} contentFit="contain" />
        ))}
      </View>
      <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 6 }}>
        {files.length > 1 ? t('stickers.dropManyTitle', { count: files.length }) : t('stickers.dropOneTitle')}
      </Text>
      <Row icon={IconSend} label={t('stickers.sendAsSticker')} onPress={() => run('send')} busy={busy === 'send'} disabled={!first || !!busy} colors={colors} />
      <Row icon={IconDownload} label={t('stickers.saveToMine')} onPress={() => run('save')} busy={busy === 'save'} disabled={!first || !!busy} colors={colors} />
      <Row icon={IconImage} label={t('stickers.sendAsPhoto')} onPress={() => { onClose?.(); onSendAsPhoto?.(files); }} disabled={!!busy} colors={colors} />
      {note ? <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 12 }}>{note}</Text> : null}
    </SheetFrame>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8,
    width: '100%', maxWidth: 560, alignSelf: 'center',
  },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  close: { position: 'absolute', right: 14, top: 12, zIndex: 2, padding: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, gap: 12 },
  rowIcon: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
