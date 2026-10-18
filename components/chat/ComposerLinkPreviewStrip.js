// [linkpreview 2026-10-18] Faixa de prévia de link ACIMA do compositor (Telegram/WhatsApp).
// Assim que a pessoa digita/cola uma URL (debounce 450 ms) busca a prévia (chat_link_preview — que também
// aquece o cache do servidor, então a mensagem já sai com o cartão no 1º frame WS). O X dispensa: o envio
// vai com no_preview=1 e a bolha sai sem cartão. JS por enquanto (o compositor nativo não tem a faixa).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { IconX, IconGlobe } from '../Icons';
import { composerLinkPreview } from './linkPreviewState';

const URL_RE = /(https?:\/\/[^\s<]+)/;
const DEBOUNCE_MS = 450;

function _host(u) { try { return ((u.match(/^https?:\/\/([^/]+)/i) || [])[1] || '').toLowerCase(); } catch { return ''; } }

/**
 * props: store (composerStore {get,subscribe}), colors, isDark, enabled (bool),
 *        skip(url) → true p/ domínios próprios, cacheGet/cacheSet (cache de prévias da conversa)
 */
export default function ComposerLinkPreviewStrip({ store, colors, isDark, enabled = true, skip, cacheGet, cacheSet }) {
  const [st, setSt] = useState(composerLinkPreview.get());
  const timerRef = useRef(null);
  const seqRef = useRef(0);

  useEffect(() => composerLinkPreview.subscribe(setSt), []);
  // Conversa nova / desmontou → faixa limpa (não vaza a dispensa de uma conversa p/ outra).
  useEffect(() => { composerLinkPreview.reset(); return () => { composerLinkPreview.reset(); if (timerRef.current) clearTimeout(timerRef.current); }; }, []);

  useEffect(() => {
    if (!store || typeof store.subscribe !== 'function') return undefined;
    const onText = (text) => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      const m = enabled && typeof text === 'string' ? text.match(URL_RE) : null;
      const url = m ? m[0] : null;
      const cur = composerLinkPreview.get();
      if (!url || (skip && skip(url))) {
        if (cur.url || cur.dismissedUrl) composerLinkPreview.set({ url: null, data: null, loading: false, dismissedUrl: null });
        return;
      }
      if (url === cur.url) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const seq = ++seqRef.current;
        const hit = cacheGet ? cacheGet(url) : undefined;
        if (hit !== undefined) {
          composerLinkPreview.set({ url, data: hit || null, loading: false, dismissedUrl: composerLinkPreview.get().dismissedUrl === url ? url : null });
          return;
        }
        composerLinkPreview.set({ url, data: null, loading: true, dismissedUrl: null });
        let api = null;
        try { api = require('../../services/api'); api = api.default || api; } catch {}
        if (!api || typeof api.chatLinkPreview !== 'function') { composerLinkPreview.set({ loading: false }); return; }
        Promise.resolve(api.chatLinkPreview(url)).then((r) => {
          if (seq !== seqRef.current) return;
          const ok = r && r.success && r.data && (r.data.title || r.data.image) && !r.data.failed;
          try { cacheSet && cacheSet(url, ok ? r.data : false); } catch {}
          if (composerLinkPreview.get().url === url) composerLinkPreview.set({ data: ok ? r.data : null, loading: false });
        }).catch(() => { if (seq === seqRef.current && composerLinkPreview.get().url === url) composerLinkPreview.set({ loading: false }); });
      }, DEBOUNCE_MS);
    };
    try { onText(store.get()); } catch {}
    return store.subscribe(onText);
  }, [store, enabled, skip, cacheGet, cacheSet]);

  if (!enabled || !st.url || st.dismissedUrl === st.url) return null;
  if (!st.loading && !st.data) return null; // sem prévia possível → nada (igual ao cartão da bolha)

  const d = st.data || {};
  const domain = String(d.site_name || _host(st.url)).replace(/^www\./i, '');
  const ink = colors?.text || (isDark ? '#FFFFFF' : '#111111');
  const sub = colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)');
  const bg = colors?.surface || (isDark ? '#1c1c1e' : '#ffffff');
  const line = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const thumbBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';

  return (
    <View style={[s.wrap, { backgroundColor: bg, borderTopColor: line }]} accessibilityLabel={d.title ? `Prévia do link: ${d.title}` : 'Prévia do link'}>
      <View style={[s.bar, { backgroundColor: ink }]} />
      <View style={[s.thumb, { backgroundColor: thumbBg }]}>
        {d.image ? (
          <ExpoImage source={{ uri: d.image }} style={s.thumbImg} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <IconGlobe size={18} color={sub} />
        )}
      </View>
      <View style={s.texts}>
        {st.loading ? (
          <>
            <View style={[s.skLine, { width: '70%', backgroundColor: thumbBg }]} />
            <View style={[s.skLine, { width: '40%', backgroundColor: thumbBg, marginTop: 6 }]} />
          </>
        ) : (
          <>
            <Text style={[s.title, { color: ink }]} numberOfLines={1}>{d.title || domain}</Text>
            <Text style={[s.sub, { color: sub }]} numberOfLines={1}>{d.description || domain}</Text>
          </>
        )}
      </View>
      <TouchableOpacity
        onPress={() => composerLinkPreview.set({ dismissedUrl: st.url })}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Remover prévia do link"
        style={s.close}
      >
        <IconX size={16} color={sub} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth, gap: 10,
    ...(Platform.OS === 'web' ? { userSelect: 'none' } : null),
  },
  bar: { width: 3, alignSelf: 'stretch', borderRadius: 2, opacity: 0.85 },
  thumb: { width: 40, height: 40, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbImg: { width: 40, height: 40 },
  texts: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { fontSize: 14, fontWeight: '600', lineHeight: 18 },
  sub: { fontSize: 12.5, lineHeight: 16, marginTop: 1 },
  skLine: { height: 10, borderRadius: 5 },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
