// components/InvitePreview.js — [grupos 2026-10-21 invite-preview]
// Cartão de prévia de convite (grupo / canal) + botão + textos de erro,
// usados por app/j/[token].js (link de grupo) e app/ch/[handle].js (canal).
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconUsers, IconMegaphone } from './Icons';

/** Código de erro do servidor → texto traduzido (o servidor responde em inglês). */
export function inviteErrorText(t, data, message, kind = 'group') {
  const code = String(data?.error || '').toLowerCase();
  const msg = String(message || '').toLowerCase();
  if (code === 'group_full' || msg.includes('limite')) return t('joinLink.full', 'Este grupo atingiu o limite de participantes.');
  if (code === 'invite_expired' || msg.includes('expired') || msg.includes('exhausted')) return t('joinLink.expired', 'Este link de convite expirou.');
  if (kind === 'channel') return t('joinLink.channelInvalid', 'Este canal não existe ou não é mais público.');
  if (code === 'invite_invalid' || code === 'invite_revoked' || msg.includes('invite') || msg.includes('token') || msg.includes('revoked')) {
    return t('joinLink.invalid', 'Este link de convite é inválido ou foi redefinido por um administrador.');
  }
  return t('chat.inviteFailed', 'Falha ao entrar no grupo');
}

export function memberCountText(t, type, n) {
  const c = Number(n) || 0;
  if (type === 'channel') return c === 1 ? t('joinLink.followerOne', '1 seguidor') : t('joinLink.followers', { count: c, defaultValue: '{count} seguidores' });
  return c === 1 ? t('joinLink.memberOne', '1 membro') : t('joinLink.members', { count: c, defaultValue: '{count} membros' });
}

/** Cartão da prévia (compartilhado com /ch/[handle]). */
export function InvitePreviewCard({ preview, colors, t, children }) {
  const isChannel = preview?.type === 'channel';
  const name = String(preview?.name || '').trim() || (isChannel ? t('joinLink.channel', 'Canal') : t('joinLink.group', 'Grupo'));
  const desc = String(preview?.description || '').trim();
  const Glyph = isChannel ? IconMegaphone : IconUsers;
  return (
    <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
      {preview?.avatar_url ? (
        <AvatarCircle uri={preview.avatar_url} name={name} size={96} />
      ) : (
        <View style={[st.glyph, { backgroundColor: colors?.surfaceVariant || colors?.surface2 }]}>
          <Glyph size={40} color={colors?.textSecondary} />
        </View>
      )}
      <Text style={[st.name, { color: colors?.text }]} numberOfLines={2} accessibilityRole="header">{name}</Text>
      <Text style={[st.meta, { color: colors?.textSecondary }]}>
        {(isChannel ? t('joinLink.channel', 'Canal') : t('joinLink.group', 'Grupo'))}
        {preview?.member_count != null ? ` · ${memberCountText(t, preview.type, preview.member_count)}` : ''}
      </Text>
      {preview?.handle ? <Text style={[st.meta, { color: colors?.textSecondary, marginTop: 2 }]}>@{preview.handle}</Text> : null}
      {desc ? (
        <Text style={[st.desc, { color: colors?.textStrong2 || colors?.text }]} numberOfLines={6}>{desc}</Text>
      ) : null}
      {children}
    </View>
  );
}

export function JoinButton({ label, onPress, colors, disabled, busy, secondary, a11yHint }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={a11yHint}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => [
        st.btn,
        secondary
          ? { backgroundColor: 'transparent' }
          : { backgroundColor: disabled ? (colors?.surfaceVariant || colors?.surface2) : colors?.primary },
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors?.onPrimary} /> : (
        <Text style={[st.btnText, { color: secondary ? colors?.textSecondary : (disabled ? colors?.textSecondary : colors?.onPrimary) }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export const st = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 24 },
  card: { width: '100%', maxWidth: 420, alignItems: 'center', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 16 },
  glyph: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center', marginTop: 14 },
  meta: { fontSize: 14, marginTop: 4, textAlign: 'center' },
  desc: { fontSize: 15, lineHeight: 21, marginTop: 14, textAlign: 'center' },
  note: { fontSize: 13, lineHeight: 18, marginTop: 14, textAlign: 'center' },
  actions: { alignSelf: 'stretch', marginTop: 20, gap: 4 },
  btn: { height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  btnText: { fontSize: 16, fontWeight: '600' },
});
