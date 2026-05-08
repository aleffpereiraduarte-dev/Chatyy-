/**
 * Family Sharing — Apple Family Sharing-style hub.
 *
 * Surfaces a single screen for managing the family unit:
 *  - Hero card with family avatar (composite of members) + name
 *  - Members section (parents + spouse + children) with role badges
 *  - Convidar familiar CTA (sends invite link with role)
 *  - Família compartilhada section: Plus/Pro plan share, shared album,
 *    shared calendar, shared shopping list, Find My Family
 *  - Settings: Family name, photo, notification prefs
 *
 * Backend wrappers in services/api.js (familyInfo, familyInvite, etc.)
 * are TODO-stubbed — most return success:false until PHP handlers ship.
 * UI degrades gracefully (skeleton, fallbacks).
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert, ActivityIndicator, TextInput, Modal, Share } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconUsers, IconPlus, IconChevronRight, IconShield, IconHeart,
  IconImage, IconStar, IconNavigation, IconBarChart, IconBell, IconCheck,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import EmptyStateCard from '../components/EmptyStateCard';
import * as api from '../services/api';

const ACCENT = '#7C3AED';
const ACCENT_LIGHT = '#A78BFA';

// Role color palette — keeps UI consistent across rows.
const ROLE_PALETTE = {
  parent: { bg: '#7C3AED22', fg: '#7C3AED', label: 'Pai/Mãe' },
  spouse: { bg: '#EC489922', fg: '#EC4899', label: 'Cônjuge' },
  child:  { bg: '#10B98122', fg: '#10B981', label: 'Criança' },
};

// Composite avatar — shows up to 4 members in a 2×2 grid, falls back to a
// single icon when nobody yet.
function FamilyComposite({ members, size = 88 }) {
  const slice = (members || []).slice(0, 4);
  const cell = size / 2;
  if (slice.length === 0) {
    return (
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: ACCENT + '22',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <IconUsers size={size * 0.45} color={ACCENT} />
      </View>
    );
  }
  if (slice.length === 1) {
    return <AvatarCircle email={slice[0].email} name={slice[0].name} size={size} ringColor={ACCENT} />;
  }
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2, overflow: 'hidden',
      flexDirection: 'row', flexWrap: 'wrap',
      borderWidth: 3, borderColor: ACCENT,
    }}>
      {slice.map((m, idx) => (
        <View key={m.email || idx} style={{ width: cell, height: cell }}>
          <AvatarCircle email={m.email} name={m.name} size={cell} />
        </View>
      ))}
    </View>
  );
}

function SectionHeader({ title, colors }) {
  return (
    <Text style={[s.sectionHeader, { color: colors.textSecondary }]}>{title}</Text>
  );
}

function FeatureRow({ icon: Icon, color, title, subtitle, onPress, colors, badge, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={disabled ? 1 : 0.65}
      disabled={disabled}
      style={[s.row, { borderBottomColor: colors.border }, disabled && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={[s.rowIcon, { backgroundColor: color + '22' }]}>
        <Icon size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowTitle, { color: colors.text }]}>{title}</Text>
        {!!subtitle && <Text style={[s.rowSub, { color: colors.textSecondary }]}>{subtitle}</Text>}
      </View>
      {!!badge && (
        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: ACCENT + '22', marginRight: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: ACCENT }}>{badge}</Text>
        </View>
      )}
      <IconChevronRight size={18} color={colors.textSecondary} />
    </TouchableOpacity>
  );
}

function MemberRow({ member, colors, isMe, onRemove }) {
  const palette = ROLE_PALETTE[member.role] || ROLE_PALETTE.child;
  return (
    <View style={[s.memberRow, { borderBottomColor: colors.border }]}>
      <AvatarCircle email={member.email} name={member.name} size={44} online={!!member.online} showStatus />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[s.memberName, { color: colors.text }]} numberOfLines={1}>
            {member.name || member.email}
            {isMe ? ' (você)' : ''}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: palette.bg }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: palette.fg }}>{palette.label}</Text>
          </View>
          {!!member.age && (
            <Text style={{ fontSize: 12, color: colors.textSecondary }}>{member.age} anos</Text>
          )}
        </View>
      </View>
      {onRemove && !isMe && (
        <TouchableOpacity onPress={() => onRemove(member)} accessibilityLabel="Remover" style={{ padding: 6 }}>
          <Text style={{ color: '#ef4444', fontSize: 13, fontWeight: '700' }}>Remover</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// Skeleton for the hero + members section while loading.
function FamilySkeleton({ colors }) {
  const block = (h, w = '100%') => (
    <View style={{ height: h, width: w, borderRadius: 12, backgroundColor: colors.borderLight, marginBottom: 10 }} />
  );
  return (
    <View style={{ padding: 20 }}>
      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: colors.borderLight, marginBottom: 12 }} />
        {block(20, 160)}
      </View>
      {block(60)}
      {block(60)}
      {block(60)}
    </View>
  );
}

export default function FamilyScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [planShare, setPlanShare] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState('');
  const [inviteRole, setInviteRole] = useState('child');
  const [inviteSending, setInviteSending] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const myEmail = (user?.email || '').toLowerCase();

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        api.familyInfo().catch(() => null),
        api.familyPlanShare().catch(() => null),
      ]);
      // Default fallback when backend not yet implemented — synthesize a
      // family from the parental list so the screen still feels alive.
      if (r1?.success && r1.data) {
        setInfo(r1.data);
      } else {
        try {
          const kids = await api.parentalListChildren();
          if (kids?.success) {
            const myName = (user?.name || (user?.email || '').split('@')[0] || 'Você').trim();
            const childMembers = (kids?.data?.children || kids?.children || []).map(c => ({
              email: c.email,
              name: c.name || c.full_name || (c.email || '').split('@')[0],
              role: 'child',
              age: c.age,
              avatar_url: c.avatar_url,
            }));
            setInfo({
              id: 'local',
              name: myName ? `Família ${myName.split(' ')[0]}` : 'Minha família',
              avatar_url: null,
              members: [
                { email: myEmail, name: myName, role: 'parent' },
                ...childMembers,
              ],
            });
          } else {
            setInfo({ id: 'local', name: 'Minha família', members: [{ email: myEmail, name: user?.name || myEmail, role: 'parent' }] });
          }
        } catch {
          setInfo({ id: 'local', name: 'Minha família', members: [{ email: myEmail, name: user?.name || myEmail, role: 'parent' }] });
        }
      }
      if (r2?.success && r2.data) setPlanShare(r2.data);
    } finally {
      setLoading(false);
    }
  }, [myEmail, user?.email, user?.name]);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const memberCount = info?.members?.length || 0;
  const childCount = useMemo(
    () => (info?.members || []).filter(m => m.role === 'child').length,
    [info]
  );

  const handleInvite = async () => {
    const target = inviteTarget.trim();
    if (!target) {
      Alert.alert('Convite', 'Informe o e-mail ou telefone do familiar.');
      return;
    }
    setInviteSending(true);
    try {
      const r = await api.familyInvite(target, inviteRole);
      if (r?.success) {
        setInviteOpen(false);
        setInviteTarget('');
        Alert.alert('Convite enviado', 'O familiar receberá um link para entrar na sua família.');
        // Optional: share link via OS share sheet so the invite can land via WhatsApp etc.
        try {
          if (r.data?.invite_url) {
            await Share.share({ message: `Entre na minha família no Chatyy: ${r.data.invite_url}` });
          }
        } catch {}
        loadInfo();
      } else {
        Alert.alert('Convite', r?.message || 'Não foi possível enviar o convite agora.');
      }
    } catch {
      Alert.alert('Convite', 'Falha de conexão. Tente novamente.');
    } finally {
      setInviteSending(false);
    }
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    try {
      const r = await api.familyUpdate({ name });
      if (r?.success) {
        setInfo(prev => prev ? { ...prev, name } : prev);
      }
    } catch {}
    setRenameOpen(false);
  };

  const confirmRemove = (member) => {
    const doRemove = async () => {
      try { await api.familyRemoveMember(member.email); } catch {}
      loadInfo();
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Remover ${member.name || member.email} da família?`)) doRemove();
    } else {
      Alert.alert('Remover familiar', `Remover ${member.name || member.email} da família?`, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Remover', style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  // Surface — main screen
  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel="Voltar">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>Família</Text>
        <View style={{ width: 30 }} />
      </View>

      {loading ? (
        <FamilySkeleton colors={colors} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Hero — family avatar + name */}
          <View style={[s.hero, { backgroundColor: isDark ? '#1a1530' : '#faf5ff' }]}>
            <FamilyComposite members={info?.members} size={96} />
            <TouchableOpacity
              onPress={() => { setRenameValue(info?.name || ''); setRenameOpen(true); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Renomear família"
              style={{ marginTop: 14, alignItems: 'center' }}
            >
              <Text style={[s.heroTitle, { color: colors.text }]}>{info?.name || 'Minha família'}</Text>
              <Text style={[s.heroSub, { color: colors.textSecondary }]}>
                {memberCount} {memberCount === 1 ? 'membro' : 'membros'}
                {childCount > 0 ? ` · ${childCount} ${childCount === 1 ? 'criança' : 'crianças'}` : ''}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Members */}
          <View style={s.section}>
            <SectionHeader title="Membros" colors={colors} />
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              {(info?.members || []).map((m, idx) => (
                <MemberRow
                  key={m.email || idx}
                  member={m}
                  colors={colors}
                  isMe={(m.email || '').toLowerCase() === myEmail}
                  onRemove={(m.email || '').toLowerCase() !== myEmail ? confirmRemove : null}
                />
              ))}
              <TouchableOpacity
                onPress={() => setInviteOpen(true)}
                activeOpacity={0.7}
                style={[s.row, { borderBottomWidth: 0 }]}
                accessibilityRole="button"
                accessibilityLabel="Convidar familiar"
              >
                <View style={[s.rowIcon, { backgroundColor: ACCENT + '22' }]}>
                  <IconPlus size={20} color={ACCENT} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.rowTitle, { color: ACCENT, fontWeight: '700' }]}>Convidar familiar</Text>
                  <Text style={[s.rowSub, { color: colors.textSecondary }]}>Adicione um pai, mãe, cônjuge ou criança</Text>
                </View>
                <IconChevronRight size={18} color={ACCENT} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Família compartilhada */}
          <View style={s.section}>
            <SectionHeader title="Família compartilhada" colors={colors} />
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <FeatureRow
                icon={IconStar}
                color="#F59E0B"
                title={planShare?.plan_name ? `Plano ${planShare.plan_name}` : 'Plano Plus/Pro'}
                subtitle={
                  planShare?.shared
                    ? `Compartilhado com ${planShare.shared_with || memberCount} membros`
                    : 'Compartilhe seu plano com até 6 pessoas'
                }
                badge={planShare?.shared ? 'Ativo' : null}
                onPress={() => router.push('/plans')}
                colors={colors}
              />
              <FeatureRow
                icon={IconImage}
                color="#EC4899"
                title="Álbum compartilhado"
                subtitle="Fotos e vídeos visíveis pra família toda"
                onPress={() => {
                  // TODO: dedicated /family-album route — for now reuse Photos.
                  router.push('/photos');
                }}
                colors={colors}
              />
              <FeatureRow
                icon={IconBarChart}
                color="#3B82F6"
                title="Calendário compartilhado"
                subtitle="Eventos visíveis pra todos os familiares"
                onPress={() => router.push('/calendar')}
                colors={colors}
              />
              <FeatureRow
                icon={IconCheck}
                color="#10B981"
                title="Lista de compras"
                subtitle="Marque junto com a família"
                onPress={() => {
                  // TODO: /family-shopping route pendente. Por enquanto Notes faz fallback.
                  router.push('/notes');
                }}
                colors={colors}
              />
              <FeatureRow
                icon={IconNavigation}
                color="#7C3AED"
                title="Encontrar família"
                subtitle="Veja a localização dos membros no mapa"
                onPress={() => {
                  // TODO: /family-map route pendente. parental-monitor tem o mapa hoje.
                  router.push('/parental-monitor');
                }}
                colors={colors}
              />
            </View>
          </View>

          {/* Settings */}
          <View style={s.section}>
            <SectionHeader title="Configurações da família" colors={colors} />
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <FeatureRow
                icon={IconUsers}
                color={ACCENT}
                title="Nome da família"
                subtitle={info?.name || 'Definir nome'}
                onPress={() => { setRenameValue(info?.name || ''); setRenameOpen(true); }}
                colors={colors}
              />
              <FeatureRow
                icon={IconImage}
                color={ACCENT_LIGHT}
                title="Foto da família"
                subtitle="Use uma foto composta dos membros"
                onPress={() => Alert.alert('Em breve', 'Foto da família compartilhada chegando logo.')}
                colors={colors}
              />
              <FeatureRow
                icon={IconBell}
                color="#F59E0B"
                title="Notificações da família"
                subtitle="Pedidos, alertas e localizações"
                onPress={() => router.push('/notifications')}
                colors={colors}
              />
              <FeatureRow
                icon={IconShield}
                color="#EF4444"
                title="Controle parental"
                subtitle={childCount > 0 ? `${childCount} ${childCount === 1 ? 'criança monitorada' : 'crianças monitoradas'}` : 'Crie uma conta para seu filho'}
                onPress={() => router.push('/parental')}
                colors={colors}
              />
            </View>
          </View>

          {memberCount <= 1 && (
            <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
              <EmptyStateCard
                Icon={IconHeart}
                title="Comece sua família no Chatyy"
                subtitle="Convide familiares para compartilhar plano, fotos, calendário e localização."
                ctaLabel="Convidar familiar"
                onPress={() => setInviteOpen(true)}
              />
            </View>
          )}
        </ScrollView>
      )}

      {/* Invite Modal */}
      <Modal visible={inviteOpen} transparent animationType="slide" onRequestClose={() => setInviteOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 }}>
            <Text style={[s.modalTitle, { color: colors.text }]}>Convidar familiar</Text>
            <Text style={[s.modalSub, { color: colors.textSecondary }]}>Envie o link pra entrar na sua família.</Text>

            <Text style={[s.label, { color: colors.textSecondary }]}>E-mail ou telefone</Text>
            <TextInput
              value={inviteTarget}
              onChangeText={setInviteTarget}
              placeholder="familiar@chatyy.com.br ou +55..."
              placeholderTextColor={colors.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              style={[s.input, { color: colors.text, backgroundColor: colors.borderLight }]}
            />

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>Papel na família</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
              {[
                { key: 'child',  label: 'Criança' },
                { key: 'parent', label: 'Pai/Mãe' },
                { key: 'spouse', label: 'Cônjuge' },
              ].map(opt => {
                const sel = inviteRole === opt.key;
                const palette = ROLE_PALETTE[opt.key];
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setInviteRole(opt.key)}
                    activeOpacity={0.75}
                    style={{
                      flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                      backgroundColor: sel ? palette.bg : colors.borderLight,
                      borderWidth: 2, borderColor: sel ? palette.fg : 'transparent',
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: sel ? palette.fg : colors.text }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => setInviteOpen(false)}
                style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]}
                accessibilityRole="button"
              >
                <Text style={[s.btnText, { color: colors.text }]}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleInvite}
                disabled={inviteSending}
                style={[s.btn, { backgroundColor: ACCENT, flex: 1, opacity: inviteSending ? 0.6 : 1 }]}
                accessibilityRole="button"
              >
                {inviteSending
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={[s.btnText, { color: '#fff' }]}>Enviar convite</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 22 }}>
            <Text style={[s.modalTitle, { color: colors.text }]}>Nome da família</Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Ex: Família Silva"
              placeholderTextColor={colors.textSecondary}
              style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, marginTop: 14 }]}
              maxLength={60}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setRenameOpen(false)} style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]} accessibilityRole="button">
                <Text style={[s.btnText, { color: colors.text }]}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleRename} style={[s.btn, { backgroundColor: ACCENT, flex: 1 }]} accessibilityRole="button">
                <Text style={[s.btnText, { color: '#fff' }]}>Salvar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700' },

  hero: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 20 },
  heroTitle: { fontSize: 22, fontWeight: '800' },
  heroSub: { fontSize: 13, marginTop: 4, fontWeight: '500' },

  section: { paddingHorizontal: 16, paddingTop: 18 },
  sectionHeader: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 14, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },

  memberRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberName: { fontSize: 15, fontWeight: '700' },

  modalTitle: { fontSize: 18, fontWeight: '800' },
  modalSub: { fontSize: 13, marginTop: 4, marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },

  btn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 15, fontWeight: '700' },
});
