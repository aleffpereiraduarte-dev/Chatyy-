// [mural 2026-10-20] Peças comuns do mural (telas 2, 3, 5 e 6 do mockup).
import React, { useEffect, useCallback, memo } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming, withSpring, Easing } from 'react-native-reanimated';
import AvatarCircle from '../AvatarCircle';
import MIcon, { AUD_ICON } from './MuralIcons';
import { LIKE, fmtCount } from './muralTheme';

// ─── Texto / tempo ──────────────────────────────────────────────────────────
function _d(v) { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; }

/** "agora", "5 min", "2 h", "ontem", "3 d", "2 sem", "12 de out." */
export function shortAgo(v, t) {
  const d = _d(v);
  if (!d) return '';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return t('mural.time.now', 'agora');
  if (s < 3600) return t('mural.time.min', { n: Math.floor(s / 60), defaultValue: `${Math.floor(s / 60)} min` });
  if (s < 86400) return t('mural.time.h', { n: Math.floor(s / 3600), defaultValue: `${Math.floor(s / 3600)} h` });
  const days = Math.floor(s / 86400);
  if (days === 1) return t('mural.time.yesterday', 'ontem');
  if (days < 7) return t('mural.time.d', { n: days, defaultValue: `${days} d` });
  if (days < 35) return t('mural.time.w', { n: Math.floor(days / 7), defaultValue: `${Math.floor(days / 7)} sem` });
  try { return d.toLocaleDateString(_loc(t), { day: 'numeric', month: 'short' }); } catch { return d.toLocaleDateString(); }
}
function _loc(t) { try { return t('mural.locale', 'pt-BR'); } catch { return 'pt-BR'; } }
/** "hoje às 17:42" / "ontem às 08:03" / "18 de out. às 11:20" */
export function fullWhen(v, t) {
  const d = _d(v);
  if (!d) return '';
  let hm = '';
  try { hm = d.toLocaleTimeString(_loc(t), { hour: '2-digit', minute: '2-digit' }); } catch { hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const dd = Math.round((b - a) / 86400000);
  if (dd === 0) return t('mural.when.today', { t: hm, defaultValue: `hoje às ${hm}` });
  if (dd === 1) return t('mural.when.yesterday', { t: hm, defaultValue: `ontem às ${hm}` });
  let day = '';
  try { day = d.toLocaleDateString(_loc(t), d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }); } catch { day = d.toLocaleDateString(); }
  return t('mural.when.date', { d: day, t: hm, defaultValue: `${day} às ${hm}` });
}

export function audienceLabel(aud, t) {
  if (aud === 'contacts') return t('mural.aud.contacts', 'Contatos');
  if (aud === 'private') return t('mural.aud.private', 'Só eu');
  return t('mural.aud.public', 'Todos');
}
export function audienceIcon(aud) { return AUD_ICON[aud] || (aud === 'private' ? 'lock' : aud === 'contacts' ? 'users' : 'globe'); }

export function count(n, t) { return fmtCount(n, _loc(t)); }

export function displayName(p) {
  return p?.author_name || (p?.author_username ? `@${p.author_username}` : '') || String(p?.author_email || '').split('@')[0];
}
export function handle(p) {
  if (p?.author_username) return p.author_username;
  return String(p?.author_email || '').split('@')[0];
}

/** "Curtido por X e outras N pessoas" (usa likes_text do servidor quando vem). */
export function likersText(post, t, me) {
  if (!post) return '';
  const n = post.likes || 0;
  if (n <= 0) return '';
  const other = (post.likers || []).find((l) => l && l.email && String(l.email).toLowerCase() !== String(me || '').toLowerCase());
  const nm = other ? (other.name || String(other.email).split('@')[0]) : '';
  if (post.liked) {
    if (n === 1) return t('mural.likedByYou', 'Curtido por você');
    if (n === 2) return t('mural.likedByYouAndOne', 'Curtido por você e outra pessoa');
    return t('mural.likedByYouAnd', { n: count(n - 1, t), defaultValue: `Curtido por você e outras ${count(n - 1, t)} pessoas` });
  }
  if (post.likes_text && !post.liked && /^pt/i.test(_loc(t))) return post.likes_text;
  if (nm) {
    if (n === 1) return t('mural.likedBy', { name: nm, defaultValue: `Curtido por ${nm}` });
    if (n === 2) return t('mural.likedByAndOne', { name: nm, defaultValue: `Curtido por ${nm} e outra pessoa` });
    return t('mural.likedByAnd', { name: nm, n: count(n - 1, t), defaultValue: `Curtido por ${nm} e outras ${count(n - 1, t)} pessoas` });
  }
  return n === 1 ? t('mural.oneLike', '1 curtida') : t('mural.nLikes', { n: count(n, t), defaultValue: `${count(n, t)} curtidas` });
}

// ─── Avatar ─────────────────────────────────────────────────────────────────
export const Avatar = memo(function Avatar({ email, name, uri, size = 40, ring, style }) {
  return <AvatarCircle email={email || undefined} name={name || email || '?'} uri={uri || undefined} size={size} style={style} />;
});

/** Pilha de avatares de quem curtiu (tela 3). */
export function LikersStack({ likers, border, size = 20 }) {
  const list = (likers || []).slice(0, 3);
  if (!list.length) return null;
  return (
    <View style={{ flexDirection: 'row' }}>
      {list.map((l, i) => (
        <View key={`${l.email || l.name}_${i}`} style={{ marginLeft: i ? -6 : 0, borderRadius: (size + 4) / 2, borderWidth: 2, borderColor: border, zIndex: 3 - i }}>
          <Avatar email={l.email} name={l.name} uri={l.avatar} size={size} />
        </View>
      ))}
    </View>
  );
}

// ─── Coração ───────────────────────────────────────────────────────────────
/** Coração com "pop" (escala .7 → 1.32 → 1) quando vira curtido. */
export function AnimatedHeart({ liked, size = 24, color, strokeWidth = 1.8 }) {
  const s = useSharedValue(1);
  const first = React.useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (liked) {
      s.value = withSequence(
        withTiming(0.7, { duration: 110, easing: Easing.out(Easing.quad) }),
        withSpring(1.32, { damping: 6, stiffness: 420, mass: 0.6 }),
        withSpring(1, { damping: 12, stiffness: 300 }),
      );
    } else {
      s.value = withSequence(withTiming(0.85, { duration: 80 }), withTiming(1, { duration: 120 }));
    }
  }, [liked]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={st}>
      <MIcon name="heart" size={size} color={liked ? LIKE : color} fill={liked ? LIKE : 'none'} strokeWidth={strokeWidth} />
    </Animated.View>
  );
}

/** Coração grande do toque duplo (sobe, assenta e some). `trigger` muda → anima. */
export function BurstHeart({ trigger, size = 110 }) {
  const o = useSharedValue(0);
  const sc = useSharedValue(0.3);
  const y = useSharedValue(0);
  useEffect(() => {
    if (!trigger) return;
    o.value = 0; sc.value = 0.3; y.value = 0;
    o.value = withSequence(withTiming(1, { duration: 130 }), withTiming(1, { duration: 590 }), withTiming(0, { duration: 180 }));
    sc.value = withSequence(withSpring(1.15, { damping: 7, stiffness: 380 }), withSpring(0.95, { damping: 10 }), withSpring(1, { damping: 12 }));
    y.value = withSequence(withTiming(0, { duration: 720 }), withTiming(-30, { duration: 180 }));
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }, { scale: sc.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: '50%', top: '50%', width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, alignItems: 'center', justifyContent: 'center' }, st, Platform.OS === 'ios' ? { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 4 } } : null]}>
      <MIcon name="heart" size={size} color="#fff" fill="#fff" strokeWidth={0} />
    </Animated.View>
  );
}

/** Botão com ícone + texto opcional (linha de ações). */
export function ActBtn({ onPress, onLongPress, children, label, style, hitSlop = 6, a11y, disabled }) {
  const press = useCallback(() => { if (!disabled) onPress?.(); }, [onPress, disabled]);
  return (
    <Pressable onPress={press} onLongPress={onLongPress} hitSlop={hitSlop} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={a11y || (typeof label === 'string' ? label : undefined)}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 10, opacity: pressed ? 0.6 : 1 }, style]}>
      {children}
    </Pressable>
  );
}

export function Meta({ text, color, size = 13 }) {
  if (!text) return null;
  return <Text style={{ color, fontSize: size }} numberOfLines={1}>{text}</Text>;
}

/** Compartilhar o link público do post (folha do sistema). */
export async function sharePost(post, t) {
  if (!post) return;
  const url = `https://chatyy.com.br/feed/${post.id}`;
  const msg = post.caption ? `${String(post.caption).slice(0, 140)}\n${url}` : url;
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ url, text: post.caption || '' }); return; }
      if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(url); try { require('../ui/Toast').showToast({ message: t('mural.linkCopied', 'Link copiado'), kind: 'success' }); } catch {} }
      return;
    }
    const { Share } = require('react-native');
    await Share.share(Platform.OS === 'ios' ? { url, message: post.caption ? String(post.caption).slice(0, 140) : undefined } : { message: msg });
  } catch {}
}
