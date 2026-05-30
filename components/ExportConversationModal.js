// ExportConversationModal — WhatsApp/Telegram-grade conversation export sheet.
//
// Replaces the old plain list-of-buttons export UI in chat-conversation.js.
// Lets the user pick a format (ZIP with media-manifest / TXT / JSON), an
// optional date range, then runs a REAL export against the backend:
//   • chat_export_zip  → server builds a .zip (messages.json + chat.html +
//                        chat.txt + metadata.json), returns a signed URL we
//                        download (web) or open/share (native).
//   • chat_export       → server returns text/json inline; we write it to a
//                        temp file and share (native) or blob-download (web).
//
// Date range is honored server-side (chat.php chat_export / chat_export_zip
// accept optional from/to ISO strings).
//
// Self-contained: owns its own loading / success / error state machine so the
// host screen only has to toggle `visible` and pass conversation context.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, Pressable, TouchableOpacity, Animated,
  Platform, ActivityIndicator, ScrollView, Share,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPackage, IconFileText, IconImage, IconX, IconCalendar, IconAlertCircle } from './Icons';
import * as api from '../services/api';

const PURPLE = '#7C3AED';

// Resolve the absolute origin for a server-relative export URL. Mirrors the
// logic the old inline modal used so behavior stays identical.
function resolveOrigin() {
  try {
    if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  } catch {}
  try {
    const base = require('../services/api').API_BASE_URL || '';
    return base.replace(/\/api\/?$/, '');
  } catch {}
  return 'https://chatyy.com.br';
}

function sanitizeFilename(name, ext) {
  const base = String(name || 'conversa')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48) || 'conversa';
  return `${base}.${ext}`;
}

export default function ExportConversationModal({
  visible,
  onClose,
  conversationId,
  conversationName = '',
  colors: colorsProp,
  t: tProp,
}) {
  const theme = useTheme();
  const lang = useLanguage();
  const colors = colorsProp || theme.colors;
  const isDark = theme.isDark;
  const t = tProp || lang.t;

  const [format, setFormat] = useState('zip'); // 'zip' | 'txt' | 'json'
  const [range, setRange] = useState('all');    // 'all' | '7d' | '30d' | 'custom'
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [resultInfo, setResultInfo] = useState(null); // { count, sizeLabel }

  const scale = useRef(new Animated.Value(0.94)).current;
  const fade = useRef(new Animated.Value(0)).current;

  // Reset transient state every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setStatus('idle');
      setErrorMsg('');
      setResultInfo(null);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 160, friction: 16 }),
        Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
    } else {
      scale.setValue(0.94);
      fade.setValue(0);
    }
  }, [visible]);

  // Compute { from, to } ISO strings for the picked range. Returns {} for
  // "all" (no filter). Custom uses date-only inputs and widens `to` to the
  // end of that day so the last day's messages are included.
  const computeRange = () => {
    const out = {};
    const now = Date.now();
    if (range === '7d') out.from = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    else if (range === '30d') out.from = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    else if (range === 'custom') {
      if (customFrom) { const d = new Date(customFrom + 'T00:00:00'); if (d.getTime()) out.from = d.toISOString(); }
      if (customTo)   { const d = new Date(customTo + 'T23:59:59');   if (d.getTime()) out.to = d.toISOString(); }
    }
    return out;
  };

  const formatLabel = useMemo(() => ({
    zip: { Icon: IconPackage, color: PURPLE, title: t('chatConv.exportZipTitle') || 'Backup completo (.zip)', sub: t('chatConv.exportZipSub') || 'Mensagens, mídia e HTML — pronto pra importar' },
    txt: { Icon: IconFileText, color: '#3b82f6', title: t('chatConv.exportTxtTitle') || 'Texto (.txt)', sub: t('chatConv.exportTxtSub') || 'Conversa em texto puro, sem mídia' },
    json: { Icon: IconImage, color: '#10b981', title: t('chatConv.exportJsonTitle') || 'Dados (.json)', sub: t('chatConv.exportJsonSub') || 'Estruturado, pra desenvolvedores' },
  }), [t]);

  const handleExport = async () => {
    if (!conversationId || status === 'loading') return;
    setStatus('loading');
    setErrorMsg('');
    const opts = computeRange();
    try {
      if (format === 'zip') {
        const r = await api.chatExportZip(conversationId, opts);
        if (!r?.success || !r.data?.url) {
          throw new Error(r?.message || (t('chatConv.exportFailed') || 'Falha ao exportar'));
        }
        const fullUrl = resolveOrigin() + r.data.url;
        const sizeKb = r.data.size ? Math.max(1, Math.round(r.data.size / 1024)) : null;
        if (Platform.OS === 'web') {
          const a = document.createElement('a');
          a.href = fullUrl;
          a.download = fullUrl.split('/').pop();
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          // Download the zip to cache then share via system sheet so the user
          // can save to Files / send anywhere.
          let FileSystem;
          try { FileSystem = require('expo-file-system/legacy'); } catch { FileSystem = require('expo-file-system'); }
          const dest = `${FileSystem.cacheDirectory}${sanitizeFilename(conversationName, 'zip')}`;
          try {
            const dl = await FileSystem.downloadAsync(fullUrl, dest);
            const Sharing = require('expo-sharing');
            if (dl?.uri && await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(dl.uri, { mimeType: 'application/zip', dialogTitle: conversationName || 'Chat' });
            } else {
              const { Linking } = require('react-native');
              await Linking.openURL(fullUrl);
            }
          } catch {
            const { Linking } = require('react-native');
            await Linking.openURL(fullUrl);
          }
        }
        setResultInfo({ count: r.data.message_count || null, sizeLabel: sizeKb ? `${sizeKb} KB` : null });
        setStatus('success');
        return;
      }

      // txt / json — server returns inline content.
      const serverFmt = format === 'json' ? 'json' : 'text';
      const r = await api.chatExport(conversationId, serverFmt, opts);
      if (!r?.success) throw new Error(r?.message || (t('chatConv.exportFailed') || 'Falha ao exportar'));

      let content;
      if (serverFmt === 'json') {
        const body = r.data?.body ?? r.data;
        content = JSON.stringify(body, null, 2);
      } else {
        content = r.data?.text ?? '';
      }
      if (!content) throw new Error(t('chatConv.exportEmpty') || 'Nada para exportar nesse período.');

      const filename = sanitizeFilename(conversationName, format === 'json' ? 'json' : 'txt');
      const mime = format === 'json' ? 'application/json' : 'text/plain';

      if (Platform.OS === 'web') {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } else {
        let FileSystem;
        try { FileSystem = require('expo-file-system/legacy'); } catch { FileSystem = require('expo-file-system'); }
        const filePath = `${FileSystem.cacheDirectory}${filename}`;
        try {
          await FileSystem.writeAsStringAsync(filePath, content, { encoding: FileSystem.EncodingType.UTF8 });
          const Sharing = require('expo-sharing');
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(filePath, { mimeType: mime, dialogTitle: conversationName || 'Chat' });
          } else {
            await Share.share({ message: content, title: filename });
          }
        } catch {
          await Share.share({ message: content, title: filename });
        } finally {
          try { await FileSystem.deleteAsync(filePath, { idempotent: true }); } catch {}
        }
      }
      setResultInfo({ count: r.data?.messages ?? null, sizeLabel: null });
      setStatus('success');
    } catch (e) {
      setErrorMsg(String(e?.message || e || (t('chatConv.exportFailed') || 'Falha ao exportar')));
      setStatus('error');
    }
  };

  const sheetBg = isDark ? '#15121F' : '#FFFFFF';
  const chipBg = isDark ? '#221C30' : '#F3EFF8';
  const chipBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const RangeChip = ({ value, label }) => {
    const active = range === value;
    return (
      <TouchableOpacity
        onPress={() => setRange(value)}
        activeOpacity={0.8}
        style={{
          paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
          backgroundColor: active ? PURPLE : chipBg,
          borderWidth: 1, borderColor: active ? PURPLE : chipBorder,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : colors.text }}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const FormatRow = ({ value }) => {
    const meta = formatLabel[value];
    const active = format === value;
    const Icon = meta.Icon;
    return (
      <TouchableOpacity
        onPress={() => setFormat(value)}
        activeOpacity={0.85}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 12,
          paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14,
          backgroundColor: active ? (isDark ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.08)') : 'transparent',
          borderWidth: 1.5, borderColor: active ? PURPLE : chipBorder,
        }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: meta.color + '22' }}>
          <Icon size={20} color={meta.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{meta.title}</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>{meta.sub}</Text>
        </View>
        <View style={{
          width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
          borderWidth: 2, borderColor: active ? PURPLE : chipBorder,
          backgroundColor: active ? PURPLE : 'transparent',
        }}>
          {active && (
            <Svg width={12} height={12} viewBox="0 0 24 24"><Path d="M5 12l5 5L20 7" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', opacity: fade }}>
        <Pressable style={{ flex: 1, justifyContent: 'flex-end' }} onPress={status === 'loading' ? undefined : onClose}>
          <Animated.View style={{ transform: [{ scale }] }}>
            <Pressable
              onPress={() => {}}
              style={{
                backgroundColor: sheetBg,
                borderTopLeftRadius: 24, borderTopRightRadius: 24,
                paddingTop: 10, paddingHorizontal: 18,
                paddingBottom: Platform.OS === 'ios' ? 34 : 20,
                maxHeight: '88%',
              }}
            >
              {/* Grabber */}
              <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 12 }} />

              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 19, fontWeight: '800', color: colors.text }}>
                    {t('chatConv.exportChat') || 'Exportar conversa'}
                  </Text>
                  {!!conversationName && (
                    <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1}>
                      {conversationName}
                    </Text>
                  )}
                </View>
                <TouchableOpacity onPress={onClose} hitSlop={12} disabled={status === 'loading'} style={{ padding: 4, opacity: status === 'loading' ? 0.4 : 1 }}>
                  <IconX size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {status === 'success' ? (
                <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(16,185,129,0.14)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                    <Svg width={34} height={34} viewBox="0 0 24 24"><Path d="M5 12l5 5L20 7" stroke="#10b981" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>
                  </View>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
                    {t('chatConv.exportDone') || 'Conversa exportada!'}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 6, textAlign: 'center' }}>
                    {Platform.OS === 'web'
                      ? (t('chatConv.exportDownloaded') || 'O arquivo foi baixado.')
                      : (t('chatConv.exportShared') || 'Escolha onde salvar ou compartilhar o arquivo.')}
                    {resultInfo?.count != null ? `\n${resultInfo.count} ${t('chatConv.messagesLower') || 'mensagens'}${resultInfo.sizeLabel ? ' · ' + resultInfo.sizeLabel : ''}` : ''}
                  </Text>
                  <TouchableOpacity onPress={onClose} activeOpacity={0.85} style={{ marginTop: 22, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 48 }}>
                    <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{t('common.done') || 'Concluído'}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={{ marginTop: 8 }}>
                  {/* Format */}
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
                    {t('chatConv.exportFormat') || 'Formato'}
                  </Text>
                  <View style={{ gap: 8 }}>
                    <FormatRow value="zip" />
                    <FormatRow value="txt" />
                    <FormatRow value="json" />
                  </View>

                  {/* Date range */}
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 18, marginBottom: 8 }}>
                    {t('chatConv.exportRange') || 'Período'}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <RangeChip value="all" label={t('chatConv.exportRangeAll') || 'Tudo'} />
                    <RangeChip value="7d" label={t('chatConv.exportRange7d') || 'Últimos 7 dias'} />
                    <RangeChip value="30d" label={t('chatConv.exportRange30d') || 'Últimos 30 dias'} />
                    <RangeChip value="custom" label={t('chatConv.exportRangeCustom') || 'Personalizado'} />
                  </View>

                  {range === 'custom' && (
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                      {Platform.OS === 'web' ? (
                        <>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>{t('chatConv.exportFrom') || 'De'}</Text>
                            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                              style={{ padding: 10, fontSize: 14, borderRadius: 10, border: `1px solid ${chipBorder}`, background: chipBg, color: colors.text, width: '100%' }} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>{t('chatConv.exportTo') || 'Até'}</Text>
                            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                              style={{ padding: 10, fontSize: 14, borderRadius: 10, border: `1px solid ${chipBorder}`, background: chipBg, color: colors.text, width: '100%' }} />
                          </View>
                        </>
                      ) : (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: chipBg, borderRadius: 10, padding: 12, flex: 1 }}>
                          <IconCalendar size={16} color={colors.textSecondary} />
                          <Text style={{ fontSize: 12, color: colors.textSecondary, flex: 1 }}>
                            {t('chatConv.exportCustomHint') || 'Datas personalizadas disponíveis na versão web. Use os atalhos acima.'}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Error */}
                  {status === 'error' && !!errorMsg && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, backgroundColor: 'rgba(239,68,68,0.10)', borderRadius: 12, padding: 12 }}>
                      <IconAlertCircle size={18} color="#ef4444" />
                      <Text style={{ flex: 1, fontSize: 13, color: '#ef4444' }}>{errorMsg}</Text>
                    </View>
                  )}

                  {/* Primary CTA */}
                  <TouchableOpacity
                    onPress={handleExport}
                    activeOpacity={0.88}
                    disabled={status === 'loading'}
                    style={{
                      marginTop: 22, backgroundColor: PURPLE, borderRadius: 16,
                      paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
                      flexDirection: 'row', gap: 10,
                      opacity: status === 'loading' ? 0.7 : 1,
                      ...(Platform.OS === 'web' ? {} : { shadowColor: PURPLE, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 }),
                    }}
                  >
                    {status === 'loading' ? (
                      <>
                        <ActivityIndicator size="small" color="#fff" />
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>{t('chatConv.exporting') || 'Exportando...'}</Text>
                      </>
                    ) : (
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                        {status === 'error' ? (t('common.tryAgain') || 'Tentar novamente') : (t('chatConv.export') || 'Exportar')}
                      </Text>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}
