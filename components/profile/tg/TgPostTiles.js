// [mural 2026-10-20] Grade (3 colunas, 2 px) e cartões (estilo X/Facebook) do
// mural — visual de preview-2026/perfil.html. Componentes memo: a lista com
// 100+ posts só re-renderiza a linha que mudou.
import React, { memo, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import FastImage from '../../FastImage';
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming, withSpring } from 'react-native-reanimated';
import TgIcon from './TgIcons';
import { THEME_V2, Grafite } from '../../../constants/theme';
import { tgT, relTime } from './tgStrings';

// [2026-10-20 grafite] tema v2: grade com vão 4, raio 10 e margem 8 (mockup).
export const GRID_GAP = THEME_V2 ? 4 : 2;
const GRID_PAD = THEME_V2 ? 8 : 0;
const TILE_R = THEME_V2 ? Grafite.radius.tile : 0;
// [muralperf 2026-10-21] cartão = versão de tela (display ≤1280) → miniatura → original; grade usa m.thumb (t320).
const _cardUri = (m) => (m && (m.display || m.thumb || m.url)) || '';
const _ph = (m) => (m && m.blurhash ? { blurhash: m.blurhash } : undefined);

// Curtir com mola de 0,35 s (Reanimated, UI thread; respeita Reduzir Movimento
// pelo padrão ReduceMotion.System do Reanimated). Tema antigo = ícone parado.
const SpringHeart = memo(function SpringHeart({ liked, size, color, fill }) {
  const sc = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!THEME_V2) return;
    sc.value = liked
      ? withSequence(withTiming(0.82, { duration: 90 }), withSpring(1, { duration: 350, dampingRatio: 0.45 }))
      : withSequence(withTiming(0.9, { duration: 70 }), withSpring(1, { duration: 350, dampingRatio: 0.8 }));
  }, [liked]); // eslint-disable-line react-hooks/exhaustive-deps
  const ast = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }] }));
  return (
    <Animated.View style={ast}>
      <TgIcon name="heart" size={size} color={color} fill={fill} />
    </Animated.View>
  );
});

export function fmtN(n, lang) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  const en = /^en/i.test(String(lang || ''));
  const k = (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '');
  return en ? `${k}K` : `${k.replace('.', ',')} mil`;
}

let _gid = 0;
function Shade({ from = 0.7, alpha = 0.28 }) {
  const id = React.useMemo(() => `tgsh${++_gid}`, []);
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 10 10">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset={String(from)} stopColor="#000" stopOpacity="0" />
          <Stop offset="1" stopColor="#000" stopOpacity={String(alpha)} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="10" height="10" fill={`url(#${id})`} />
    </Svg>
  );
}

function _isInk(p) {
  if (p.style === 'ink' || p.style === 'dark') return true;
  if (p.style === 'paper' || p.style === 'light') return false;
  const n = Number(String(p.id).replace(/\D/g, '')) || 0;
  return n % 2 === 0;
}

const Tile = memo(function Tile({ post, w, h, th, lang, onPress }) {
  const p = post;
  const pend = p.__pending;
  const meta = (
    <View style={st.meta} pointerEvents="none">
      <TgIcon name="heart" size={13} color="#fff" strokeWidth={2.2} />
      <Text style={st.metaTxt}>{fmtN(p.like_count, lang)}</Text>
    </View>
  );
  if (!p.media.length) {
    const ink = _isInk(p);
    const fg = ink ? th.inkInk : th.paperInk;
    return (
      <Pressable onPress={() => onPress(p)} style={[{ width: w, height: h, backgroundColor: ink ? th.ink : th.paper, paddingHorizontal: 11, paddingTop: 12, paddingBottom: 26, justifyContent: 'center', borderRadius: TILE_R, overflow: 'hidden' }, !ink && { borderWidth: StyleSheet.hairlineWidth, borderColor: th.line }]} accessibilityRole="button" accessibilityLabel={p.text.slice(0, 80)}>
        <Text style={[st.quote, { color: fg }]}>{'“'}</Text>
        <Text style={[st.tileTxt, { color: fg }]} numberOfLines={6}>{p.text}</Text>
        <View style={[st.meta, { opacity: 0.6 }]} pointerEvents="none">
          <TgIcon name="heart" size={13} color={fg} strokeWidth={2.2} />
          <Text style={[st.metaTxt, { color: fg, textShadowRadius: 0 }]}>{fmtN(p.like_count, lang)}</Text>
        </View>
        {pend ? <PendingBadge pend={pend} lang={lang} /> : null}
      </Pressable>
    );
  }
  const m0 = p.media[0];
  const cap = String(p.text || '').trim();
  return (
    <Pressable onPress={() => onPress(p)} style={{ width: w, height: h, backgroundColor: th.chip, overflow: 'hidden', borderRadius: TILE_R }} accessibilityRole="button" accessibilityLabel={cap ? cap.slice(0, 80) : tgT(lang, 'tabPosts')}>
      <FastImage source={{ uri: m0.thumb || m0.url }} placeholder={m0.blurhash ? { blurhash: m0.blurhash } : undefined} transition={m0.blurhash ? 120 : 0} style={StyleSheet.absoluteFill} resizeMode="cover" recyclingKey={`${p.id}`} />
      <Shade from={cap ? 0.45 : 0.7} alpha={cap ? 0.6 : 0.28} />
      {(p.media.length > 1 || p.count > 1) ? <View style={st.multi} pointerEvents="none"><TgIcon name="stack" size={17} color="#fff" strokeWidth={2} /></View> : (m0.type === 'video' ? <View style={st.multi} pointerEvents="none"><TgIcon name="play" size={15} color="#fff" fill="#fff" strokeWidth={1} /></View> : null)}
      {cap ? <Text style={st.cap2} numberOfLines={2}>{cap}</Text> : null}
      {meta}
      {pend ? <PendingBadge pend={pend} lang={lang} /> : null}
    </Pressable>
  );
});

function PendingBadge({ pend, lang }) {
  const failed = pend.status === 'failed';
  return (
    <View style={st.pendWrap} pointerEvents="none">
      {failed ? null : <ActivityIndicator size="small" color="#fff" />}
      <Text style={st.pendTxt}>{failed ? tgT(lang, 'failed') : tgT(lang, 'pending')}</Text>
    </View>
  );
}

export const GridRow = memo(function GridRow({ row, width, th, lang, onPress }) {
  const w = (width - GRID_PAD * 2 - GRID_GAP * 2) / 3;
  const h = w * (4 / 3);
  return (
    <View style={{ flexDirection: 'row', marginBottom: GRID_GAP, backgroundColor: th.bg, paddingHorizontal: GRID_PAD }}>
      {row.map((p, i) => (
        <View key={String(p.id)} style={{ marginLeft: i ? GRID_GAP : 0 }}>
          <Tile post={p} w={w} h={h} th={th} lang={lang} onPress={onPress} />
        </View>
      ))}
    </View>
  );
});

/** Quadrado da aba Mídia (1:1). */
export const MediaRow = memo(function MediaRow({ row, width, th, onPress }) {
  const w = (width - GRID_PAD * 2 - GRID_GAP * 2) / 3;
  return (
    <View style={{ flexDirection: 'row', marginBottom: GRID_GAP, paddingHorizontal: GRID_PAD }}>
      {row.map((it, i) => (
        <Pressable key={String(it.key)} onPress={() => onPress(it)} style={{ width: w, height: w, marginLeft: i ? GRID_GAP : 0, backgroundColor: th.chip, overflow: 'hidden', borderRadius: TILE_R }} accessibilityRole="imagebutton">
          {it.thumb ? <FastImage source={it.headers ? { uri: it.thumb, headers: it.headers } : { uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" recyclingKey={String(it.key)} /> : null}
          {it.video ? <View style={st.multi} pointerEvents="none"><TgIcon name="play" size={15} color="#fff" fill="#fff" strokeWidth={1} /></View> : null}
        </Pressable>
      ))}
    </View>
  );
});

const AUD_ICON = { public: 'globe', everyone: 'globe', contacts: 'users', private: 'lock' };

// [2026-10-22 mural-toque] Toque na mídia do cartão: 1 toque = abre (depois de 250 ms, p/ ver se é duplo);
// 2 toques = CURTE (como o Instagram: só curte, nunca descurte) + coração grande; e trava de 800 ms
// depois de abrir (vários toques abriam a tela várias vezes).
const DOUBLE_MS = 250;
const OPEN_LOCK_MS = 800;
let _lastOpenAt = 0;
function _openOnce(fn, p) {
  const now = Date.now();
  if (now - _lastOpenAt < OPEN_LOCK_MS) return;
  _lastOpenAt = now;
  try { fn && fn(p); } catch {}
}
const BigHeart = memo(function BigHeart({ trigger, color }) {
  const op = useSharedValue(0);
  const sc = useSharedValue(0.4);
  useEffect(() => {
    if (!trigger) return;
    op.value = withSequence(withTiming(1, { duration: 90 }), withTiming(1, { duration: 420 }), withTiming(0, { duration: 220 }));
    sc.value = withSequence(withSpring(1.1, { duration: 320, dampingRatio: 0.5 }), withTiming(1, { duration: 200 }));
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  const ast = useAnimatedStyle(() => ({ opacity: op.value, transform: [{ scale: sc.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, ast]}>
      <TgIcon name="heart" size={96} color={color || '#FFFFFF'} fill={color || '#FFFFFF'} />
    </Animated.View>
  );
});

export const PostCard = memo(function PostCard({ post, th, lang, author, onOpen, onLike, onComments, onShare, onMore, onBookmark, bookmarked, shadow }) {
  const p = post;
  const imgs = p.media.slice(0, 3);
  const big = !p.media.length && p.text.length < 90;
  const name = (author && author.name) || (p.author && p.author.name) || '';
  const handle = (author && author.username) || (p.author && p.author.username) || '';
  const sub = [handle ? `@${handle}` : '', relTime(lang, p.created_at)].filter(Boolean).join(' · ');
  const tapRef = useRef({ at: 0, timer: null });
  const [heartN, setHeartN] = React.useState(0);
  useEffect(() => () => { if (tapRef.current.timer) clearTimeout(tapRef.current.timer); }, []);
  const onMediaPress = () => {
    const r = tapRef.current;
    const now = Date.now();
    if (r.timer && now - r.at < DOUBLE_MS) {
      clearTimeout(r.timer); r.timer = null; r.at = 0;
      setHeartN((n) => n + 1);
      if (!p.liked_by_me && !p.__pending) { try { onLike && onLike(p); } catch {} }
      return;
    }
    r.at = now;
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => { r.timer = null; _openOnce(onOpen, p); }, DOUBLE_MS);
  };
  return (
    <View style={[st.pcard, { backgroundColor: th.card }, shadow]}>
      <View style={st.ph}>
        {author && author.avatar ? author.avatar(40) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.who, { color: th.text }]} numberOfLines={1}>{name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={[st.whoSub, { color: th.muted }]} numberOfLines={1}>{sub}{sub ? ' · ' : ''}</Text>
            <TgIcon name={AUD_ICON[p.audience] || 'globe'} size={13} color={th.muted} />
          </View>
        </View>
        <Pressable onPress={() => onMore(p)} hitSlop={8} style={st.moreBtn} accessibilityRole="button" accessibilityLabel={tgT(lang, 'more')}>
          <TgIcon name="more" size={18} color={th.muted} />
        </Pressable>
      </View>
      {p.text ? (
        <Pressable onPress={() => _openOnce(onOpen, p)}>
          <Text style={[big ? st.ptxtBig : st.ptxt, { color: th.text }]}>{p.text}</Text>
        </Pressable>
      ) : null}
      {imgs.length ? (
        <Pressable onPress={onMediaPress} style={[st.pimgs, imgs.length > 1 && { flexDirection: 'row' }]}>
          {imgs.length === 1 ? (
            <FastImage source={{ uri: _cardUri(imgs[0]) }} placeholder={_ph(imgs[0])} transition={imgs[0].blurhash ? 120 : 0} style={{ width: '100%', aspectRatio: imgs[0].w && imgs[0].h ? Math.max(0.8, Math.min(1.6, imgs[0].w / imgs[0].h)) : 4 / 3.4, backgroundColor: th.chip }} resizeMode="cover" recyclingKey={`c${p.id}`} />
          ) : imgs.length === 2 ? (
            imgs.map((m, i) => <FastImage key={i} source={{ uri: _cardUri(m) }} placeholder={_ph(m)} style={{ flex: 1, aspectRatio: 3 / 4, marginLeft: i ? 2 : 0, backgroundColor: th.chip }} resizeMode="cover" />)
          ) : (
            <>
              <FastImage source={{ uri: _cardUri(imgs[0]) }} placeholder={_ph(imgs[0])} style={{ flex: 2, height: 242, backgroundColor: th.chip }} resizeMode="cover" />
              <View style={{ flex: 1, marginLeft: 2 }}>
                <FastImage source={{ uri: _cardUri(imgs[1]) }} placeholder={_ph(imgs[1])} style={{ height: 120, backgroundColor: th.chip }} resizeMode="cover" />
                <FastImage source={{ uri: _cardUri(imgs[2]) }} placeholder={_ph(imgs[2])} style={{ height: 120, marginTop: 2, backgroundColor: th.chip }} resizeMode="cover" />
              </View>
            </>
          )}
          {p.media.length > 3 ? <View style={st.countPill}><Text style={st.countPillTxt}>+{p.media.length - 3}</Text></View> : null}
          <BigHeart trigger={heartN} color="#FFFFFF" />
        </Pressable>
      ) : null}
      {p.__pending ? <View style={{ paddingTop: 8 }}><Text style={{ color: th.muted, fontSize: 13 }}>{p.__pending.status === 'failed' ? tgT(lang, 'failed') : tgT(lang, 'pending')}</Text></View> : (
        <View style={st.pact}>
          <Pressable onPress={() => onLike(p)} style={st.pbtn} accessibilityRole="button" accessibilityState={{ selected: !!p.liked_by_me }}>
            <SpringHeart liked={!!p.liked_by_me} size={22} color={p.liked_by_me ? th.like : th.muted} fill={p.liked_by_me ? th.like : 'none'} />
            <Text style={[st.pbtnTxt, { color: p.liked_by_me ? th.like : th.muted }]}>{fmtN(p.like_count, lang)}</Text>
          </Pressable>
          {p.allow_comments ? (
            <Pressable onPress={() => onComments(p)} style={st.pbtn} accessibilityRole="button">
              <TgIcon name="comment" size={22} color={th.muted} />
              <Text style={[st.pbtnTxt, { color: th.muted }]}>{fmtN(p.comment_count, lang)}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => onShare(p)} style={st.pbtn} accessibilityRole="button" accessibilityLabel={tgT(lang, 'share')}>
            <TgIcon name="share" size={22} color={th.muted} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => onBookmark(p)} style={st.pbtn} accessibilityRole="button">
            <TgIcon name="bookmark" size={22} color={bookmarked ? th.text : th.muted} fill={bookmarked ? th.text : 'none'} />
          </Pressable>
        </View>
      )}
    </View>
  );
});

const st = StyleSheet.create({
  meta: { position: 'absolute', left: 6, bottom: 5, flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaTxt: { color: '#fff', fontSize: 11.5, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  multi: { position: 'absolute', right: 6, top: 6 },
  quote: { fontSize: 30, lineHeight: 22, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', opacity: 0.35, marginBottom: 2 },
  tileTxt: { fontSize: 13, fontWeight: '600', lineHeight: 16.6, letterSpacing: -0.1 },
  cap2: { position: 'absolute', left: 7, right: 7, bottom: 23, color: '#fff', fontSize: 11.5, fontWeight: '600', lineHeight: 14.4, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  pendWrap: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', gap: 6 },
  pendTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  pcard: { marginHorizontal: 10, borderRadius: THEME_V2 ? Grafite.radius.card : 18, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6, marginBottom: 8 },
  ph: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  who: { fontSize: 15, fontWeight: '700' },
  whoSub: { fontSize: 13, flexShrink: 1 },
  moreBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  ptxt: { marginTop: 10, fontSize: 15.5, lineHeight: 22 },
  ptxtBig: { marginTop: 10, fontSize: 21, lineHeight: 27, fontWeight: '600', letterSpacing: -0.3 },
  pimgs: { marginTop: 10, borderRadius: THEME_V2 ? 16 : 14, overflow: 'hidden' },
  countPill: { position: 'absolute', right: 10, top: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  countPillTxt: { color: '#fff', fontSize: 12, fontWeight: '600' },
  pact: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginLeft: -8 },
  pbtn: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 10 },
  pbtnTxt: { fontSize: 14, fontWeight: '500' },
});
