/**
 * HighlightShareSheet — surfaces the public /h/<id> link for a destaque.
 *
 * Action sheet style (bottom modal) with two affordances:
 *   1. Copy link to clipboard (uses expo-clipboard if available, falls back
 *      to navigator.clipboard on web).
 *   2. Native share via Share.share (system share sheet) — gives the user
 *      WhatsApp/Twitter/etc. without us caring about routing.
 *
 * The /h/<id> route is a static SPA that fetches status_highlight_public
 * (no auth) and plays the highlight in a web stories viewer. Falls back to
 * "abrir no app" CTA via custom URL scheme chatyy://h/<id>.
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, Share, Platform, Alert,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { IconX, IconLink, IconShare, IconCopy, IconCheck } from './Icons';

let _Clipboard = null;
try { _Clipboard = require('expo-clipboard'); } catch (e) {}

const PUBLIC_BASE = 'https://chatyy.com.br/h/';

export default function HighlightShareSheet({
  visible, onClose, highlight, colors, isDark, t,
}) {
  const T = t || ((k, d) => d || k);
  const c = colors || {};
  const sheetBg = c.surface || (isDark ? '#1a1a1a' : '#fff');
  const txt = c.text || (isDark ? '#fff' : '#000');
  const sub = c.textSecondary || (isDark ? '#999' : '#666');
  const border = c.border || (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
  const accent = '#7C3AED';

  const [copied, setCopied] = useState(false);
  const url = highlight?.id ? `${PUBLIC_BASE}${highlight.id}` : '';

  const copyLink = async () => {
    if (!url) return;
    try {
      if (_Clipboard?.setStringAsync) {
        await _Clipboard.setStringAsync(url);
      } else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        Alert.alert(T('common.error', 'Erro'), 'clipboard_unavailable');
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      Alert.alert(T('common.error', 'Erro'), e?.message || 'copy_failed');
    }
  };

  const nativeShare = async () => {
    if (!url) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({
          title: highlight?.title || T('profile.shareHighlightTitle', 'Destaque · Chatyy'),
          url,
        });
        return;
      }
      await Share.share({
        title: highlight?.title || T('profile.shareHighlightTitle', 'Destaque · Chatyy'),
        message: `${highlight?.title || T('profile.shareHighlightTitle', 'Destaque · Chatyy')}\n${url}`,
        url,
      });
    } catch (e) {
      // user cancelled — silent
    }
  };

  const Row = ({ icon, label, onPress, hint, accentColor }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: (accentColor || accent) + '22' }}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: txt, fontWeight: '600', fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: sub, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{hint}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal visible={!!visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: sheetBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden', paddingBottom: 30 }}>
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }} />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }}>
            <Text style={{ flex: 1, fontWeight: '700', fontSize: 16, color: txt }}>
              {T('profile.shareHighlight', 'Compartilhar destaque')}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
              <IconX size={22} color={txt} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: 18, paddingVertical: 10 }}>
            <Text style={{ color: sub, fontSize: 12, fontWeight: '500' }}>{T('profile.shareHighlightLinkLabel', 'Link público')}</Text>
            <Text selectable style={{ color: txt, fontSize: 14, marginTop: 4 }} numberOfLines={1}>{url}</Text>
          </View>

          <Row
            icon={copied ? <IconCheck size={18} color="#10b981" /> : <IconCopy size={18} color={accent} />}
            label={copied ? T('common.copied', 'Copiado!') : T('common.copyLink', 'Copiar link')}
            hint={url}
            onPress={copyLink}
            accentColor={copied ? '#10b981' : accent}
          />
          <Row
            icon={<IconShare size={18} color={accent} />}
            label={T('common.shareEllipsis', 'Compartilhar…')}
            hint={T('profile.shareHighlightSystem', 'Abre o menu do sistema')}
            onPress={nativeShare}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
