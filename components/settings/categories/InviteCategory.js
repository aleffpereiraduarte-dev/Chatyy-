// [2026-10-15 settings-split] Categoria "Convidar amigos". Dados: settingsCache 'referral'.
//
// [2026-10-19 convite-premium] Página completa P&B:
//   • cartão do topo (grupo `nativeHeader` → vai como cartão RN no topo da lista
//     nativa; na tela JS é um grupo normal): ilustração SVG, link pessoal
//     (copiar), QR do link, botões WhatsApp / SMS / E-mail / Mais (folha do sistema);
//   • progresso: get_referral_code devolve referred_count (chat_referrals);
//   • "Convide seus contatos": agenda que AINDA NÃO usa o Chatyy (contactSync →
//     check_contacts + hash), só depois do consentimento + permissão do sistema
//     (nunca pede sozinho ao abrir; usa o cache do último sync). Linhas do kit
//     → continuam na lista nativa.
// Sem promessa de bônus (o servidor não concede GB por convite hoje).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert, Linking, Platform, Share, StyleSheet } from 'react-native';
import Svg, { Rect, Circle, Path, G } from 'react-native-svg';
import { useLanguage } from '../../../context/LanguageContext';
import { IconCopy, IconShare, IconMessageCircle, IconMessageSquare, IconMail, IconCheck, IconUserPlus, IconTag } from '../../Icons';
import InviteCodeSheet from '../InviteCodeSheet'; // [bia-convite 2026-10-19]
import { SettingsGroup, SettingsRow, SettingsValueText, useGroupedColors } from '../SettingsKit';
import { HapticsCompat as Haptics } from '../../../services/haptics';
import { useSection } from './shared';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

const PAGE = 25;
const MILESTONES = [1, 3, 5, 10, 25, 50, 100, 250, 500, 1000];

function inviteLink(code) {
  return code ? `https://chatyy.com.br/signup?ref=${encodeURIComponent(code)}` : 'https://chatyy.com.br';
}

// Número da agenda → dígitos internacionais (wa.me / sms).
function intlDigits(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D+/g, '');
  if (!d) return '';
  if (s.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  let home = '55';
  try { home = require('../../../services/contactSync').getHomeDialDigits() || '55'; } catch {}
  d = d.replace(/^0+/, '');
  if (d.startsWith(home) && d.length >= 12) return d;
  return home + d;
}

function openSms(digits, msg) {
  const body = encodeURIComponent(msg);
  const to = digits ? `+${digits}` : '';
  const url = Platform.OS === 'ios' ? `sms:${to}&body=${body}` : `sms:${to}?body=${body}`;
  return Linking.openURL(url);
}

async function openWhatsApp(digits, msg) {
  const text = encodeURIComponent(msg);
  if (Platform.OS !== 'web') {
    const app = digits ? `whatsapp://send?phone=${digits}&text=${text}` : `whatsapp://send?text=${text}`;
    try { await Linking.openURL(app); return; } catch {}
  }
  await Linking.openURL(digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`);
}

// Ilustração P&B: duas bolhas de conversa + pessoa + selo "+".
function InviteArt({ g, width = 220 }) {
  const ink = g.ink;
  const paper = g.cardBg;
  const soft = g.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.10)';
  const h = Math.round(width * 0.56);
  return (
    <Svg width={width} height={h} viewBox="0 0 220 124" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx="24" cy="30" r="3" fill={soft} />
      <Circle cx="200" cy="96" r="4" fill={soft} />
      <Circle cx="190" cy="16" r="2.5" fill={soft} />
      <Circle cx="14" cy="92" r="2" fill={soft} />
      {/* bolha cheia (quem convida) */}
      <G>
        <Rect x="30" y="18" width="104" height="66" rx="24" fill={ink} />
        <Path d="M50 80 L42 100 L66 84 Z" fill={ink} />
        <Circle cx="62" cy="51" r="5" fill={paper} />
        <Circle cx="82" cy="51" r="5" fill={paper} />
        <Circle cx="102" cy="51" r="5" fill={paper} />
      </G>
      {/* bolha contorno (amigo) */}
      <G>
        <Rect x="98" y="46" width="92" height="62" rx="22" fill={paper} stroke={ink} strokeWidth="2.5" />
        <Path d="M170 104 L180 120 L156 107" fill={paper} stroke={ink} strokeWidth="2.5" strokeLinejoin="round" />
        <Rect x="168" y="100" width="12" height="6" fill={paper} />
        <Circle cx="144" cy="69" r="9" fill="none" stroke={ink} strokeWidth="2.5" />
        <Path d="M126 96 C128 85 160 85 162 96" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      </G>
      {/* selo + */}
      <Circle cx="186" cy="44" r="14" fill={ink} stroke={paper} strokeWidth="3" />
      <Path d="M186 37 V51 M179 44 H193" stroke={paper} strokeWidth="2.6" strokeLinecap="round" />
    </Svg>
  );
}

function ShareButton({ label, Icon, onPress, g }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.shareBtn, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
    >
      <View style={[s.shareCircle, { backgroundColor: g.fill }]}>
        <Icon size={22} color={g.text} />
      </View>
      <Text style={[s.shareLabel, { color: g.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function InviteHeroCard({ code, link, message, t, g }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(link);
      else await require('expo-clipboard').setStringAsync(link);
      try { Haptics.notificationAsync('success'); } catch {}
      setCopied(true);
    } catch {}
  }, [link]);

  const shareSheet = useCallback(async () => {
    if (Platform.OS === 'web') {
      try { if (navigator.share) { await navigator.share({ text: message, url: link }); return; } } catch { return; }
      copy();
      return;
    }
    try { await Share.share({ message }); } catch {}
  }, [message, link, copy]);

  const viaWhatsApp = useCallback(() => { openWhatsApp('', message).catch(() => shareSheet()); }, [message, shareSheet]);
  const viaSms = useCallback(() => { openSms('', message).catch(() => shareSheet()); }, [message, shareSheet]);
  const viaEmail = useCallback(() => {
    const subject = encodeURIComponent(t('invite.emailSubject', 'Vem para o Chatyy'));
    Linking.openURL(`mailto:?subject=${subject}&body=${encodeURIComponent(message)}`).catch(() => shareSheet());
  }, [message, t, shareSheet]);

  const shown = link.replace(/^https?:\/\//, '');
  return (
    <View style={s.hero}>
      <InviteArt g={g} />
      <Text style={[s.heroTitle, { color: g.text }]} accessibilityRole="header">{t('invite.heroTitle', 'Traga seus amigos para o Chatyy')}</Text>
      <Text style={[s.heroSub, { color: g.secondary }]}>{t('invite.heroSub', 'Mensagens, chamadas e e-mail num app só. Envie o seu link pessoal para quem você quiser.')}</Text>

      <Text style={[s.label, { color: g.header }]}>{t('invite.yourLink', 'Seu link de convite').toUpperCase()}</Text>
      <Pressable
        onPress={copy}
        style={({ pressed }) => [s.linkPill, { backgroundColor: g.fill }, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityLabel={`${t('invite.copyLink', 'Copiar link')}: ${shown}`}
      >
        <Text style={[s.linkText, { color: g.text }]} numberOfLines={1} ellipsizeMode="middle">{shown}</Text>
        <View style={[s.copyChip, { backgroundColor: g.ink }]}>
          {copied ? <IconCheck size={14} color={g.onInk} /> : <IconCopy size={14} color={g.onInk} />}
          <Text style={[s.copyText, { color: g.onInk }]}>{copied ? t('invite.copied', 'Copiado') : t('invite.copy', 'Copiar')}</Text>
        </View>
      </Pressable>
      {!!code && (
        <Text style={[s.codeLine, { color: g.secondary }]}>
          {t('referral.yourCode', 'Seu código')}: <Text style={[s.codeVal, { color: g.text }]}>{code}</Text>
        </Text>
      )}

      {!!QRCode && !!code && (
        <View style={s.qrBlock}>
          <View style={[s.qrTile, g.isDark ? null : { borderColor: g.separator, borderWidth: StyleSheet.hairlineWidth }]}>
            <QRCode value={link} size={156} color="#0B0B0C" backgroundColor="#FFFFFF" ecl="M" />
          </View>
          <Text style={[s.qrCaption, { color: g.secondary }]}>{t('invite.qrCaption', 'Peça para apontar a câmera do celular')}</Text>
        </View>
      )}

      <View style={s.shareRow}>
        <ShareButton g={g} label="WhatsApp" Icon={IconMessageCircle} onPress={viaWhatsApp} />
        <ShareButton g={g} label={t('invite.sms', 'SMS')} Icon={IconMessageSquare} onPress={viaSms} />
        <ShareButton g={g} label={t('invite.email', 'E-mail')} Icon={IconMail} onPress={viaEmail} />
        <ShareButton g={g} label={t('invite.more', 'Mais')} Icon={IconShare} onPress={shareSheet} />
      </View>
    </View>
  );
}

function ProgressCard({ count, t, g }) {
  const next = MILESTONES.find(m => m > count) || (count + 100);
  const prev = [...MILESTONES].reverse().find(m => m <= count) || 0;
  const pct = Math.max(0.04, Math.min(1, (count - prev) / Math.max(1, next - prev)));
  const title = count === 1
    ? t('invite.joinedOne', '1 amigo entrou pelo seu convite')
    : t('invite.joinedMany', '{n} amigos entraram pelo seu convite').split('{n}').join(String(count));
  const left = next - count;
  const hint = count === 0
    ? t('invite.progressZero', 'Quando alguém criar a conta pelo seu link, aparece aqui.')
    : (left === 1 ? t('invite.progressNextOne', 'Falta 1 para chegar a {m}') : t('invite.progressNext', 'Faltam {k} para chegar a {m}'))
      .split('{k}').join(String(left)).split('{m}').join(String(next));
  return (
    <View style={s.prog} accessible accessibilityLabel={`${title}. ${hint}`}>
      <View style={s.progTop}>
        <Text style={[s.progNum, { color: g.text }]}>{count}</Text>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={[s.progTitle, { color: g.text }]} numberOfLines={2}>{title}</Text>
          <Text style={[s.progHint, { color: g.secondary }]} numberOfLines={2}>{hint}</Text>
        </View>
      </View>
      <View style={[s.bar, { backgroundColor: g.fill }]}>
        <View style={[s.barFill, { backgroundColor: g.ink, width: `${Math.round(pct * 100)}%` }]} />
      </View>
    </View>
  );
}

// "Convide seus contatos" — agenda sem Chatyy.
function useInviteContacts(t) {
  const [state, setState] = useState(Platform.OS === 'web' ? 'web' : 'idle'); // idle|loading|denied|ready|error|web
  const [list, setList] = useState([]);

  // [2026-10-19 convite-wa] limpeza/ordem A–Z compartilhada com /invite-friends
  // (símbolos/emojis não vão mais para o topo; sem nome → número formatado).
  const apply = useCallback((others) => {
    let out = [];
    try { out = require('../../../services/inviteContacts').prepareInviteContacts(others).map((c) => ({ name: c.display, phone: c.phone, phoneLabel: c.phoneLabel, key: c.key })); } catch {}
    setList(out);
    setState('ready');
  }, []);

  const load = useCallback(async (force) => {
    if (Platform.OS === 'web') return;
    setState('loading');
    try {
      const cs = require('../../../services/contactSync');
      const r = await cs.syncContacts(!!force, t);
      if (r?.error === 'consent_denied' || r?.error === 'consent_required') { setState('idle'); return; }
      if (r?.error === 'permission_denied') { setState('denied'); return; }
      if (r?.error && !(r.otherContacts || []).length) { setState('error'); return; }
      apply(r?.otherContacts);
    } catch { setState('error'); }
  }, [apply, t]);

  // Abrir a tela nunca pede consentimento/permissão: só o cache, ou um sync
  // quando os dois já foram dados antes.
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let alive = true;
    (async () => {
      try {
        const cs = require('../../../services/contactSync');
        const cached = await cs.getCachedContacts();
        if (!alive) return;
        if (cached) { apply(cached.otherContacts); return; }
        if ((await cs.getContactsConsentState()) === 'granted' && (await cs.hasContactsPermissionNoPrompt())) {
          if (alive) load(false);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [apply, load]);

  return { state, list, load };
}

export default function InviteCategory() {
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const ref = useSection('referral');
  const code = (ref && ref.code) || '';
  const count = Number((ref && ref.referred_count) || 0);
  const link = inviteLink(code);
  const message = useMemo(
    () => t('invite.shareMessage', 'Vem conversar comigo no Chatyy: mensagens, chamadas e e-mail num app só. Entre pelo meu convite: {link}').split('{link}').join(link),
    [t, link],
  );
  const { state, list, load } = useInviteContacts(t);
  const [limit, setLimit] = useState(PAGE);
  const [codeSheet, setCodeSheet] = useState(false); // [bia-convite 2026-10-19] "Tenho um código de convite"

  const inviteContact = useCallback((c) => {
    const digits = intlDigits(c.phone);
    const sms = () => { openSms(digits, message).catch(() => {}); };
    const wa = () => { openWhatsApp(digits, message).catch(() => {}); };
    const more = () => { Share.share({ message }).catch(() => {}); };
    try { Haptics.selectionAsync(); } catch {}
    // Android mostra no máx. 3 botões → sem "Cancelar" (toque fora fecha).
    Alert.alert(
      t('invite.inviteName', 'Convidar {name}').split('{name}').join(c.name),
      c.phone,
      [
        { text: 'WhatsApp', onPress: wa },
        { text: t('invite.sms', 'SMS'), onPress: sms },
        { text: t('invite.more', 'Mais'), onPress: more },
      ],
      { cancelable: true },
    );
  }, [message, t]);

  const shown = list.slice(0, limit);
  const contactsFooter = state === 'ready' && list.length
    ? t('invite.contactsFooter', 'Contatos da sua agenda que ainda não usam o Chatyy. O convite sai pelo seu WhatsApp ou SMS.')
    : t('invite.contactsFooterIdle', 'Mostramos só quem da sua agenda ainda não está no Chatyy. Nada é enviado sem você tocar em Convidar.');

  return (
    <View>
      <SettingsGroup nativeHeader>
        {code ? (
          <InviteHeroCard code={code} link={link} message={message} t={t} g={gc} />
        ) : (
          <View style={s.heroLoading}><ActivityIndicator color={gc.text} /></View>
        )}
      </SettingsGroup>

      {!!code && (
        <SettingsGroup nativeHeader>
          <ProgressCard count={count} t={t} g={gc} />
        </SettingsGroup>
      )}

      {/* [bia-convite 2026-10-19] código digitado depois do cadastro (apply_referral) */}
      <SettingsGroup footer={t('invite.code.footer', 'Entrou sem usar o link de quem te convidou? Digite o código aqui.')}>
        <SettingsRow
          icon={IconTag}
          title={t('invite.code.title', 'Tenho um código de convite')}
          onPress={() => setCodeSheet(true)}
        />
      </SettingsGroup>

      {state !== 'web' && (
        <SettingsGroup header={t('invite.contactsHeader', 'Convide seus contatos')} footer={contactsFooter}>
          {state === 'idle' && (
            <SettingsRow
              icon={IconUserPlus}
              title={t('invite.findContacts', 'Encontrar contatos para convidar')}
              onPress={() => load(true)}
            />
          )}
          {state === 'loading' && (
            <SettingsRow title={t('invite.loadingContacts', 'Procurando na sua agenda…')} right={<ActivityIndicator size="small" color={gc.text} />} />
          )}
          {state === 'denied' && (
            <SettingsRow
              title={t('invite.allowContacts', 'Permitir acesso aos contatos')}
              subtitle={t('invite.allowContactsSub', 'Abra os ajustes do sistema e libere Contatos para o Chatyy')}
              onPress={() => { Linking.openSettings?.().catch?.(() => {}); }}
            />
          )}
          {state === 'error' && (
            <SettingsRow title={t('invite.contactsError', 'Não consegui ler sua agenda agora')} subtitle={t('invite.tapToRetry', 'Toque para tentar de novo')} onPress={() => load(true)} />
          )}
          {state === 'ready' && !list.length && (
            <SettingsRow title={t('invite.allOnChatyy', 'Todos os seus contatos já estão no Chatyy')} />
          )}
          {state === 'ready' && shown.map((c) => (
            <SettingsRow
              key={c.key || (c.phone + c.name)}
              title={c.name}
              subtitle={c.phoneLabel || c.phone}
              subtitleLines={1}
              onPress={() => inviteContact(c)}
              right={<SettingsValueText color={gc.text}>{t('invite.inviteCta', 'Convidar')}</SettingsValueText>}
            />
          ))}
          {state === 'ready' && list.length > limit && (
            <SettingsRow
              title={t('invite.showMore', 'Mostrar mais ({n})').split('{n}').join(String(list.length - limit))}
              center
              chevron={false}
              onPress={() => setLimit((l) => l + PAGE * 2)}
            />
          )}
        </SettingsGroup>
      )}
      <InviteCodeSheet visible={codeSheet} onClose={() => setCodeSheet(false)} t={t} />
    </View>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 20 },
  heroLoading: { height: 220, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 22, fontWeight: '600', letterSpacing: -0.4, marginTop: 14, textAlign: 'center' },
  heroSub: { fontSize: 14, lineHeight: 20, marginTop: 6, textAlign: 'center', maxWidth: 320 },
  label: { alignSelf: 'stretch', fontSize: 12, fontWeight: '500', letterSpacing: 0.4, marginTop: 22, marginBottom: 8, marginLeft: 4 },
  linkPill: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, minHeight: 48 },
  linkText: { flex: 1, fontSize: 15, fontWeight: '500', marginRight: 10 },
  copyChip: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  copyText: { fontSize: 13, fontWeight: '600', marginLeft: 6 },
  codeLine: { alignSelf: 'stretch', fontSize: 13, marginTop: 8, marginLeft: 4 },
  codeVal: { fontWeight: '600', letterSpacing: 1.2, fontVariant: ['tabular-nums'] },
  qrBlock: { alignItems: 'center', marginTop: 22 },
  qrTile: { padding: 14, borderRadius: 20, backgroundColor: '#FFFFFF' },
  qrCaption: { fontSize: 13, marginTop: 10 },
  shareRow: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', marginTop: 24, paddingHorizontal: 4 },
  shareBtn: { alignItems: 'center', width: 72 },
  shareCircle: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  shareLabel: { fontSize: 12, fontWeight: '500', marginTop: 6 },
  prog: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 18 },
  progTop: { flexDirection: 'row', alignItems: 'center' },
  progNum: { fontSize: 40, fontWeight: '600', letterSpacing: -1, fontVariant: ['tabular-nums'], minWidth: 34 },
  progTitle: { fontSize: 15, fontWeight: '600' },
  progHint: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  bar: { height: 6, borderRadius: 3, marginTop: 14, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
});
