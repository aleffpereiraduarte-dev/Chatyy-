// [conta-empresarial 2026-10-24] Configurações > Conta empresarial (nível WhatsApp Business).
// Uma rota, várias vistas (?view=): home | cnpj | creator | profile | catalog | item | orders | messages | labels | bia | public.
//   - Transformar em conta empresarial: CNPJ conferido pelo servidor (dígitos + consulta pública, situação ATIVA)
//     e mostrado para confirmar; sem CNPJ (outros países / negócio / criador) = conta comercial sem CNPJ.
//   - Perfil comercial, catálogo/cardápio (foto, preço, disponível), mensagens de saudação/ausência,
//     respostas rápidas, etiquetas, Bia atendente (liga/pausa, tom, entrega, FAQ) e painel de pedidos.
// Servidor: biz_* (services/business.js) — fora da allowlist do servidor a tela mostra "indisponível".
// Sem Modal sobre Modal: cada vista é uma tela (push na mesma rota); seletores = OptionSheet de 1 nível.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Image, Platform, Linking } from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import { safeAlert } from '../services/alerts';
import { HapticsCompat as Haptics } from '../services/haptics';
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsCardContent,
  useGroupedColors, useSettingsInputStyle,
} from '../components/settings/SettingsKit';
import {
  IconBriefcase, IconPackage, IconClock, IconTag, IconMapPin, IconReceipt, IconMessageSquare, IconGlobe, IconPhone, IconMail,
  IconPlus, IconTrash, IconImage, IconSparkles, IconShield, IconUsers,
} from '../components/Icons';
import HoursEditor, { hoursValid, dayLabel } from '../components/business/HoursEditor';
import * as B from '../services/business';
import { useAuth } from '../context/AuthContext';

function openConv(cid, name) {
  try { require('../services/openConversation').openConversation(`/chat-conversation?id=${encodeURIComponent(String(cid))}${name ? `&name=${encodeURIComponent(name)}` : ''}`); } catch {}
}

const one = (v) => (Array.isArray(v) ? v[0] : v);

function errText(t, code) {
  const map = {
    cnpj_invalid: t('biz.err.cnpjInvalid', 'CNPJ inválido. Confira os números.'),
    cnpj_not_found: t('biz.err.cnpjNotFound', 'Não encontramos esse CNPJ na consulta pública.'),
    cnpj_not_active: t('biz.err.cnpjNotActive', 'Esse CNPJ não está ATIVO na Receita Federal.'),
    cnpj_taken: t('biz.err.cnpjTaken', 'Esse CNPJ já está ligado a outra conta empresarial.'),
    too_many_attempts: t('biz.err.tooMany', 'Muitas tentativas. Tente de novo mais tarde.'),
    lookup_unavailable: t('biz.err.lookupDown', 'A consulta de CNPJ está fora do ar agora. Tente em alguns minutos.'),
    content_rejected: t('biz.err.content', 'Esse texto não pode ser usado (moderação). Tente com outras palavras.'),
    name_required: t('biz.err.name', 'Informe o nome.'),
    price_invalid: t('biz.err.price', 'Preço inválido.'),
    website_invalid: t('biz.err.website', 'Site inválido.'),
    email_invalid: t('biz.err.email', 'E-mail inválido.'),
    biz_disabled: t('biz.err.disabled', 'A conta empresarial ainda não está disponível para a sua conta.'),
    network: t('biz.err.network', 'Sem conexão. Tente de novo.'),
  };
  return map[code] || t('biz.err.generic', 'Não deu certo agora. Tente de novo.');
}

function useBizStatus() {
  const [st, setSt] = useState(() => B.bizStatusCached());
  const [loading, setLoading] = useState(!st);
  const reload = useCallback(async () => {
    const r = await B.bizStatus();
    if (r.ok) setSt(r.data);
    setLoading(false);
    return r;
  }, []);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  return { st, loading, reload };
}

function Field({ label, value, onChangeText, placeholder, multiline, keyboardType, maxLength, autoCapitalize }) {
  const g = useGroupedColors();
  const input = useSettingsInputStyle();
  return (
    <SettingsCardContent>
      {label ? <Text style={[s.fieldLbl, { color: g.secondary }]}>{label}</Text> : null}
      <TextInput
        style={[input, multiline && { minHeight: 88, textAlignVertical: 'top' }]}
        value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={g.tertiary}
        multiline={multiline} keyboardType={keyboardType} maxLength={maxLength} autoCapitalize={autoCapitalize}
        accessibilityLabel={label || placeholder}
      />
    </SettingsCardContent>
  );
}

function PrimaryButton({ title, onPress, busy, disabled, destructive }) {
  const g = useGroupedColors();
  return (
    <Pressable
      onPress={busy || disabled ? undefined : onPress}
      accessibilityRole="button" accessibilityLabel={title}
      style={[s.btn, { backgroundColor: destructive ? g.destructive : g.ink, opacity: disabled ? 0.4 : 1 }]}
    >
      {busy ? <ActivityIndicator color={g.onInk} /> : <Text style={[s.btnTxt, { color: destructive ? '#fff' : g.onInk }]}>{title}</Text>}
    </Pressable>
  );
}

function Pill({ text }) {
  const g = useGroupedColors();
  return <View style={[s.pill, { backgroundColor: g.fill }]}><Text style={[s.pillTxt, { color: g.text }]}>{text}</Text></View>;
}

export function categoryLabel(t, c) {
  const fb = {
    restaurant: 'Restaurante', food_delivery: 'Delivery de comida', bakery: 'Padaria e confeitaria', market: 'Mercado',
    fashion: 'Moda e acessórios', beauty: 'Beleza e estética', health: 'Saúde', fitness: 'Academia e esportes', education: 'Educação',
    services: 'Serviços', retail: 'Loja', tech: 'Tecnologia', auto: 'Automotivo', home: 'Casa e construção', events: 'Eventos',
    travel: 'Viagem e turismo', pets: 'Pets', creator: 'Criador de conteúdo', ngo: 'ONG e causas', other: 'Outros',
  }[c];
  return c ? t(`biz.cat.${c}`, fb || c) : t('biz.cat.none', 'Sem categoria');
}
export function statusLabel(t, st) {
  const fb = { new: 'Novo', confirmed: 'Confirmado', ready: 'Pronto', delivered: 'Entregue', cancelled: 'Cancelado' }[st] || st;
  return t(`biz.order.st.${st}`, fb);
}

// ─── raiz ───────────────────────────────────────────────────────────────────
export default function BusinessAccountScreen() {
  const p = useLocalSearchParams();
  const view = one(p.view) || 'home';
  const { t } = useLanguage();
  const { st, loading, reload } = useBizStatus();
  const title = {
    home: t('biz.title', 'Conta empresarial'), cnpj: t('biz.cnpj.title', 'Empresa com CNPJ'), creator: t('biz.creator.title', 'Negócio sem CNPJ'),
    profile: t('biz.profile.title', 'Perfil comercial'), catalog: t('biz.catalog.title', 'Catálogo'), item: t('biz.item.title', 'Item do catálogo'),
    orders: t('biz.orders.title', 'Pedidos'), messages: t('biz.messages.title', 'Mensagens automáticas'), labels: t('biz.labels.title', 'Etiquetas'),
    bia: t('biz.bia.title', 'Bia atendente'), public: t('biz.public.title', 'Perfil comercial'),
  }[view] || t('biz.title', 'Conta empresarial');

  if (view === 'public') return <SettingsScreen title={title}><PublicView email={one(p.email)} t={t} /></SettingsScreen>;
  if (loading && !st) return <SettingsScreen title={title}><ActivityIndicator style={{ marginTop: 40 }} /></SettingsScreen>;
  if (!st || !st.enabled) {
    return (
      <SettingsScreen title={title}>
        <SettingsGroup footer={t('biz.unavailable', 'A conta empresarial ainda não está disponível para a sua conta. Ela chega aos poucos para todos.')}>
          <SettingsRow icon={IconBriefcase} title={t('biz.title', 'Conta empresarial')} subtitle={t('biz.soon', 'Em breve')} />
        </SettingsGroup>
      </SettingsScreen>
    );
  }
  const acct = st.account;
  let body = null;
  if (!acct) {
    if (view === 'cnpj') body = <CnpjStep t={t} onDone={reload} />;
    else if (view === 'creator') body = <CreatorStep t={t} st={st} onDone={reload} />;
    else body = <Onboard t={t} />;
  } else {
    switch (view) {
      case 'profile': body = <ProfileEdit t={t} st={st} onSaved={reload} />; break;
      case 'catalog': body = <CatalogList t={t} />; break;
      case 'item': body = <ItemEdit t={t} id={Number(one(p.id)) || 0} />; break;
      case 'orders': body = <Orders t={t} />; break;
      case 'messages': body = <MessagesEdit t={t} />; break;
      case 'labels': body = <LabelsEdit t={t} />; break;
      case 'bia': body = <BiaEdit t={t} onSaved={reload} />; break;
      default: body = <Home t={t} st={st} reload={reload} />;
    }
  }
  return <SettingsScreen title={title}>{body}</SettingsScreen>;
}

// ─── sem conta: escolher caminho ────────────────────────────────────────────
function Onboard({ t }) {
  const router = useRouter();
  const g = useGroupedColors();
  return (
    <>
      <SettingsCardContent>
        <Text style={[s.lead, { color: g.text }]}>{t('biz.onb.title', 'Transforme sua conta em conta empresarial')}</Text>
        <Text style={[s.body, { color: g.secondary }]}>
          {t('biz.onb.body', 'Mostre o rótulo "Conta comercial", seu catálogo, horário e endereço, responda com mensagens automáticas e ligue a Bia para atender seus clientes e anotar pedidos.')}
        </Text>
      </SettingsCardContent>
      <SettingsGroup header={t('biz.onb.choose', 'Como é o seu negócio?')}>
        <SettingsRow icon={IconBriefcase} title={t('biz.onb.cnpj', 'Tenho CNPJ')} subtitle={t('biz.onb.cnpjSub', 'Empresa ou MEI no Brasil. Conferimos o CNPJ na consulta pública da Receita.')}
          onPress={() => router.push({ pathname: '/business-account', params: { view: 'cnpj' } })} />
        <SettingsRow icon={IconUsers} title={t('biz.onb.noCnpj', 'Não tenho CNPJ')} subtitle={t('biz.onb.noCnpjSub', 'Negócio sem CNPJ, criador de conteúdo ou empresa de outro país. Conta comercial sem o dado de CNPJ.')}
          onPress={() => router.push({ pathname: '/business-account', params: { view: 'creator' } })} />
      </SettingsGroup>
      <SettingsGroup footer={t('biz.onb.privacy', 'Guardamos só o necessário: CNPJ, razão social, nome fantasia, atividade (CNAE), cidade e UF. Não guardamos sócios nem dados pessoais da consulta. Uma conta empresarial por CNPJ.')} />
    </>
  );
}

function CnpjStep({ t, onDone }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [cnpj, setCnpj] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const valid = B.cnpjValid(cnpj);
  const lookup = async () => {
    setErr(''); setRes(null);
    if (!valid) { setErr(errText(t, 'cnpj_invalid')); return; }
    setBusy(true);
    const r = await B.cnpjLookup(cnpj);
    setBusy(false);
    if (!r.ok) { setErr(errText(t, r.error)); return; }
    setRes(r.data);
  };
  const confirm = async () => {
    setBusy(true);
    const r = await B.bizCreate({ kind: 'company', cnpj: res.cnpj, confirm: 1 });
    setBusy(false);
    if (!r.ok) { setErr(errText(t, r.error)); return; }
    try { Haptics.notificationAsync?.('success'); } catch {}
    await onDone();
    try { router.replace({ pathname: '/business-account', params: { view: 'home' } }); } catch {}
  };
  const dispute = async () => {
    const r = await B.bizDispute(res.cnpj);
    safeAlert(t('biz.cnpj.disputeTitle', 'Pedido enviado'), r.ok ? t('biz.cnpj.disputeOk', 'O suporte vai analisar e falar com você. Se o CNPJ for seu, liberamos para a sua conta.') : errText(t, r.error));
  };
  const row = (k, v) => (v ? <SettingsRow title={k} value={String(v)} numberOfLines={2} /> : null);
  return (
    <>
      <SettingsGroup header={t('biz.cnpj.label', 'CNPJ')} footer={t('biz.cnpj.hint', 'Aceita CNPJ numérico e o novo CNPJ alfanumérico. A situação precisa estar ATIVA.')}>
        <Field value={B.maskCnpj(cnpj)} onChangeText={(v) => { setCnpj(B.normalizeCnpj(v)); setRes(null); setErr(''); }} placeholder="00.000.000/0000-00" autoCapitalize="characters" maxLength={18} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]} accessibilityLiveRegion="polite">{err}</Text> : null}
      {!res ? <PrimaryButton title={t('biz.cnpj.check', 'Consultar CNPJ')} onPress={lookup} busy={busy} disabled={cnpj.length < 14} /> : null}
      {res ? (
        <>
          <SettingsGroup header={t('biz.cnpj.found', 'Confira os dados da empresa')}>
            {row(t('biz.cnpj.f.cnpj', 'CNPJ'), res.cnpj_masked)}
            {row(t('biz.cnpj.f.situation', 'Situação'), res.situacao)}
            {row(t('biz.cnpj.f.legal', 'Razão social'), res.legal_name)}
            {row(t('biz.cnpj.f.trade', 'Nome fantasia'), res.trade_name)}
            {row(t('biz.cnpj.f.cnae', 'Atividade (CNAE)'), res.cnae_desc ? `${res.cnae_code} · ${res.cnae_desc}` : '')}
            {row(t('biz.cnpj.f.nature', 'Natureza jurídica'), res.legal_nature)}
            {row(t('biz.cnpj.f.address', 'Endereço'), [res.street, res.district, res.city && `${res.city}/${res.uf}`].filter(Boolean).join(' · '))}
            {row(t('biz.cnpj.f.opened', 'Abertura'), res.opened_on)}
          </SettingsGroup>
          {!res.active ? <Text style={[s.err, { color: g.destructive }]}>{errText(t, 'cnpj_not_active')}</Text> : null}
          {res.taken && !res.taken_by_me ? (
            <>
              <Text style={[s.err, { color: g.destructive }]}>{errText(t, 'cnpj_taken')}</Text>
              <PrimaryButton title={t('biz.cnpj.dispute', 'Este CNPJ é meu — pedir revisão')} onPress={dispute} />
            </>
          ) : null}
          {res.active && !res.taken ? (
            <>
              <Text style={[s.note, { color: g.secondary }]}>{t('biz.cnpj.confirmNote', 'Ao confirmar, você declara que representa esta empresa. O selo de verificado é um processo à parte.')}</Text>
              <PrimaryButton title={t('biz.cnpj.confirm', 'Confirmar e transformar em conta empresarial')} onPress={confirm} busy={busy} />
            </>
          ) : null}
          <Pressable onPress={() => { setRes(null); setCnpj(''); }} style={s.link} accessibilityRole="button">
            <Text style={[s.linkTxt, { color: g.secondary }]}>{t('biz.cnpj.other', 'Consultar outro CNPJ')}</Text>
          </Pressable>
        </>
      ) : null}
    </>
  );
}

function CreatorStep({ t, st, onDone }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [name, setName] = useState('');
  const [cat, setCat] = useState('');
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cats = (st && st.categories) || B.BIZ_CATEGORIES;
  const create = async () => {
    setErr('');
    setBusy(true);
    const r = await B.bizCreate({ kind: 'creator', display_name: name.trim(), category: cat, city: city.trim() });
    setBusy(false);
    if (!r.ok) { setErr(errText(t, r.error)); return; }
    await onDone();
    try { router.replace({ pathname: '/business-account', params: { view: 'home' } }); } catch {}
  };
  return (
    <>
      <SettingsGroup header={t('biz.creator.data', 'Seu negócio')} footer={t('biz.creator.note', 'Sem CNPJ a conta mostra "Conta comercial", mas não exibe dados de empresa. Você pode informar o CNPJ depois.')}>
        <Field label={t('biz.f.name', 'Nome do negócio')} value={name} onChangeText={setName} maxLength={80} />
        <SettingsPickerRow title={t('biz.f.category', 'Categoria')} value={cat} onChange={setCat}
          options={cats.map((c) => ({ value: c, label: categoryLabel(t, c) }))} displayValue={cat ? categoryLabel(t, cat) : ''} />
        <Field label={t('biz.f.city', 'Cidade / país')} value={city} onChangeText={setCity} maxLength={80} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      <PrimaryButton title={t('biz.creator.create', 'Criar conta comercial')} onPress={create} busy={busy} disabled={!name.trim()} />
    </>
  );
}

// ─── hub ────────────────────────────────────────────────────────────────────
function Home({ t, st, reload }) {
  const router = useRouter();
  const g = useGroupedColors();
  const a = st.account; const p = st.profile || {}; const bia = st.bia || {};
  const go = (view, params = {}) => router.push({ pathname: '/business-account', params: { view, ...params } });
  const { user } = useAuth() || {};
  const [opening, setOpening] = useState(false);
  const toggleBia = async (v) => { await B.biaSave({ enabled: v }); reload(); };
  const openBiaChat = async () => {
    setOpening(true);
    const r = await B.biaOpen(true);
    setOpening(false);
    if (r.ok && r.data.conversation_id) openConv(r.data.conversation_id, t('biz.botName', 'Configurar Bia'));
    else safeAlert(t('biz.title', 'Conta empresarial'), errText(t, r.error));
  };
  const remove = () => safeAlert(t('biz.remove.title', 'Voltar para conta pessoal?'),
    t('biz.remove.body', 'O rótulo "Conta comercial" sai do perfil e a Bia atendente é desligada. Catálogo e pedidos ficam guardados se você voltar.'),
    [{ text: t('common.cancel', 'Cancelar'), style: 'cancel' },
     { text: t('biz.remove.ok', 'Voltar para pessoal'), style: 'destructive', onPress: async () => { await B.bizRemove(); reload(); } }]);
  return (
    <>
      <SettingsCardContent style={{ alignItems: 'flex-start', gap: 6 }}>
        <Text style={[s.lead, { color: g.text }]} numberOfLines={2}>{p.display_name || a.trade_name || a.legal_name}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Pill text={t('biz.label', 'Conta comercial')} />
          {a.verified ? <Pill text={t('biz.verified', 'Verificada')} /> : null}
          {a.kind === 'company' && a.cnpj_masked ? <Pill text={`${t('biz.cnpjChecked', 'CNPJ conferido')} · ${a.cnpj_masked}`} /> : null}
          {a.kind === 'creator' ? <Pill text={t('biz.noCnpj', 'Sem CNPJ')} /> : null}
        </View>
        {p.category ? <Text style={[s.body, { color: g.secondary }]}>{categoryLabel(t, p.category)}</Text> : null}
      </SettingsCardContent>
      <SettingsGroup header={t('biz.h.profile', 'Perfil')}>
        <SettingsRow icon={IconBriefcase} title={t('biz.profile.title', 'Perfil comercial')} subtitle={t('biz.profile.sub', 'Categoria, descrição, horário, endereço, site e contatos')} onPress={() => go('profile')} />
        <SettingsRow icon={IconPackage} title={t('biz.catalog.title', 'Catálogo')} subtitle={t('biz.catalog.sub', 'Cardápio ou produtos com foto, preço e disponibilidade')} onPress={() => go('catalog')} />
        <SettingsRow icon={IconGlobe} title={t('biz.public.see', 'Ver como cliente')} onPress={() => go('public', { email: String((user && user.email) || '') })} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.h.sales', 'Atendimento')}>
        <SettingsRow icon={IconReceipt} title={t('biz.orders.title', 'Pedidos')} value={st.open_orders ? String(st.open_orders) : ''} subtitle={t('biz.orders.sub', 'Novos, confirmados, prontos e entregues')} onPress={() => go('orders')} />
        <SettingsRow icon={IconMessageSquare} title={t('biz.messages.title', 'Mensagens automáticas')} subtitle={t('biz.messages.sub', 'Saudação, ausência e respostas rápidas')} onPress={() => go('messages')} />
        <SettingsRow icon={IconTag} title={t('biz.labels.title', 'Etiquetas')} subtitle={t('biz.labels.sub', 'Organize seus clientes')} onPress={() => go('labels')} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.h.bia', 'Bia atendente')} footer={t('biz.bia.footer', 'A Bia responde seus clientes com base no seu perfil, cardápio e perguntas frequentes, anota pedidos para você confirmar e passa para uma pessoa quando pedirem. Conversas com a Bia ligada não usam criptografia de ponta a ponta, e o cliente é avisado.')}>
        <SettingsSwitchRow icon={IconSparkles} title={t('biz.bia.on', 'Bia responde meus clientes')} subtitle={bia.paused ? t('biz.bia.paused', 'Pausada') : ''} value={!!bia.enabled} onValueChange={toggleBia} />
        <SettingsRow icon={IconSparkles} title={t('biz.bia.settings', 'Ajustes da Bia')} onPress={() => go('bia')} />
        <SettingsRow icon={IconMessageSquare} title={t('biz.bia.chat', 'Configurar Bia pela conversa')} subtitle={t('biz.bia.chatSub', 'Como o BotFather do Telegram: comandos e botões')} onPress={openBiaChat} right={opening ? <ActivityIndicator /> : undefined} />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow title={t('biz.remove.row', 'Voltar para conta pessoal')} destructive onPress={remove} />
      </SettingsGroup>
    </>
  );
}

// ─── perfil comercial ───────────────────────────────────────────────────────
function ProfileEdit({ t, st, onSaved }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [f, setF] = useState(() => ({ ...(st.profile || {}), hours: B.normalizeHours((st.profile || {}).hours) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const cats = st.categories || B.BIZ_CATEGORIES;
  const save = async () => {
    setErr('');
    if (!hoursValid(f.hours)) { setErr(t('biz.err.hours', 'Confira os horários (formato 09:00).')); return; }
    setBusy(true);
    const r = await B.profileSave({
      display_name: f.display_name || '', category: f.category || '', description: f.description || '', hours: f.hours,
      address: f.address || '', website: f.website || '', contact_email: f.contact_email || '', contact_phone: f.contact_phone || '',
    });
    setBusy(false);
    if (!r.ok) { setErr(errText(t, r.error)); return; }
    await onSaved();
    try { router.back(); } catch {}
  };
  const openMap = () => {
    const q = encodeURIComponent(f.address || '');
    if (!q) return;
    const url = Platform.OS === 'ios' ? `http://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
    Linking.openURL(url).catch(() => {});
  };
  return (
    <>
      <SettingsGroup header={t('biz.h.basic', 'Básico')}>
        <Field label={t('biz.f.name', 'Nome do negócio')} value={f.display_name} onChangeText={set('display_name')} maxLength={80} />
        <SettingsPickerRow title={t('biz.f.category', 'Categoria')} value={f.category} onChange={set('category')}
          options={cats.map((c) => ({ value: c, label: categoryLabel(t, c) }))} displayValue={f.category ? categoryLabel(t, f.category) : ''} />
        <Field label={t('biz.f.description', 'Descrição')} value={f.description} onChangeText={set('description')} multiline maxLength={1000} />
      </SettingsGroup>
      <HoursEditor t={t} value={f.hours} onChange={set('hours')} header={t('biz.f.hours', 'Horário de atendimento')} />
      <SettingsGroup header={t('biz.f.where', 'Endereço e contato')}>
        <Field label={t('biz.f.address', 'Endereço')} value={f.address} onChangeText={set('address')} maxLength={300} />
        {f.address ? <SettingsRow icon={IconMapPin} title={t('biz.f.openMap', 'Ver no mapa')} onPress={openMap} /> : null}
        <Field label={t('biz.f.website', 'Site')} value={f.website} onChangeText={set('website')} autoCapitalize="none" keyboardType="url" maxLength={200} />
        <Field label={t('biz.f.email', 'E-mail comercial')} value={f.contact_email} onChangeText={set('contact_email')} autoCapitalize="none" keyboardType="email-address" maxLength={120} />
        <Field label={t('biz.f.phone', 'Telefone comercial')} value={f.contact_phone} onChangeText={set('contact_phone')} keyboardType="phone-pad" maxLength={30} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      <PrimaryButton title={t('biz.save', 'Salvar')} onPress={save} busy={busy} />
    </>
  );
}

// ─── catálogo ───────────────────────────────────────────────────────────────
function CatalogList({ t }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [items, setItems] = useState(null);
  const [cur, setCur] = useState('BRL');
  const load = useCallback(async () => { const r = await B.catalogList(); if (r.ok) { setItems(r.data.items || []); setCur(r.data.currency || 'BRL'); } else setItems([]); }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const toggle = async (it, v) => {
    setItems((l) => l.map((x) => (x.id === it.id ? { ...x, available: v } : x)));
    await B.itemSave({ ...it, price_cents: it.price_cents, available: v });
  };
  if (!items) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const sections = [];
  items.forEach((it) => { const k = it.section || ''; let sct = sections.find((x) => x.k === k); if (!sct) { sct = { k, list: [] }; sections.push(sct); } sct.list.push(it); });
  return (
    <>
      <SettingsGroup>
        <SettingsRow icon={IconPlus} title={t('biz.catalog.add', 'Adicionar item')} onPress={() => router.push({ pathname: '/business-account', params: { view: 'item', id: '0' } })} />
      </SettingsGroup>
      {!items.length ? <Text style={[s.note, { color: g.secondary }]}>{t('biz.catalog.empty', 'Seu catálogo está vazio. Adicione itens com foto, preço e descrição — a Bia usa só o que estiver aqui.')}</Text> : null}
      {sections.map((sct) => (
        <SettingsGroup key={sct.k || '_'} header={sct.k || t('biz.catalog.noSection', 'Itens')}>
          {sct.list.map((it) => (
            <SettingsRow
              key={it.id}
              left={it.photo_url ? <Image source={{ uri: it.photo_url }} style={s.thumb} /> : <View style={[s.thumb, { backgroundColor: g.fill, alignItems: 'center', justifyContent: 'center' }]}><IconImage size={18} color={g.secondary} /></View>}
              title={it.name}
              subtitle={`${B.money(it.price_cents, cur)}${it.available ? '' : ' · ' + t('biz.item.soldOut', 'Esgotado')}`}
              onPress={() => router.push({ pathname: '/business-account', params: { view: 'item', id: String(it.id) } })}
              onLongPress={() => toggle(it, !it.available)}
            />
          ))}
        </SettingsGroup>
      ))}
      {items.length ? <Text style={[s.note, { color: g.secondary }]}>{t('biz.catalog.hint', 'Toque e segure um item para marcar como esgotado ou disponível.')}</Text> : null}
    </>
  );
}

async function pickAndUpload() {
  let ImagePicker;
  try { ImagePicker = require('expo-image-picker'); } catch { return { error: 'no_picker' }; }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (perm.status !== 'granted') return { error: 'permission' };
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
  if (res.canceled || !res.assets || !res.assets[0]) return { canceled: true };
  const a = res.assets[0];
  const file = { uri: a.uri, name: a.fileName || 'item.jpg', type: a.mimeType || 'image/jpeg', size: a.fileSize };
  try {
    const up = await require('../services/r2DirectUpload').uploadDirect(file, { context: 'chat' });
    if (up && up.success && up.cdn_url) return { url: up.cdn_url };
  } catch {}
  // reserva: upload antigo do módulo de negócios (servidor US)
  try {
    const { getAuthHeaders, BASE_URL } = require('../services/api');
    const fd = new FormData();
    if (Platform.OS === 'web') fd.append('photo', await fetch(a.uri).then((r) => r.blob()), 'item.jpg');
    else fd.append('photo', { uri: a.uri, type: 'image/jpeg', name: 'item.jpg' });
    const r = await fetch(`${BASE_URL}/api/email.php?action=business_upload_product_photo`, { method: 'POST', headers: getAuthHeaders(), body: fd, credentials: 'include' });
    const j = await r.json();
    if (j && j.success && j.data && j.data.url) return { url: j.data.url };
  } catch {}
  return { error: 'upload' };
}

function ItemEdit({ t, id }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [f, setF] = useState(id ? null : { name: '', section: '', price: '', description: '', photo_url: '', available: true });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!id) return;
    B.catalogList().then((r) => {
      const it = r.ok ? (r.data.items || []).find((x) => x.id === id) : null;
      setF(it ? { ...it, price: B.centsToInput(it.price_cents) } : { name: '', section: '', price: '', description: '', photo_url: '', available: true });
    });
  }, [id]);
  if (!f) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setErr('');
    const cents = B.parseMoney(f.price);
    if (!f.name.trim()) { setErr(errText(t, 'name_required')); return; }
    if (cents === null) { setErr(errText(t, 'price_invalid')); return; }
    setBusy(true);
    const r = await B.itemSave({ id: id || undefined, name: f.name.trim(), section: f.section || '', price_cents: cents, description: f.description || '', photo_url: f.photo_url || '', available: !!f.available });
    setBusy(false);
    if (!r.ok) { setErr(errText(t, r.error)); return; }
    try { router.back(); } catch {}
  };
  const del = () => safeAlert(t('biz.item.delTitle', 'Apagar este item?'), '', [
    { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
    { text: t('biz.item.del', 'Apagar'), style: 'destructive', onPress: async () => { await B.itemDelete(id); try { router.back(); } catch {} } },
  ]);
  const photo = async () => {
    setUploading(true);
    const r = await pickAndUpload();
    setUploading(false);
    if (r.url) set('photo_url')(r.url);
    else if (r.error === 'permission') safeAlert(t('biz.item.photo', 'Foto'), t('biz.item.photoPerm', 'Permita o acesso às fotos para escolher a imagem.'));
    else if (r.error) safeAlert(t('biz.item.photo', 'Foto'), t('biz.item.photoErr', 'Não consegui enviar a foto. Tente de novo.'));
  };
  return (
    <>
      <SettingsGroup>
        <Pressable onPress={photo} accessibilityRole="button" accessibilityLabel={t('biz.item.photo', 'Foto')} style={[s.photoBox, { backgroundColor: g.fill }]}>
          {f.photo_url ? <Image source={{ uri: f.photo_url }} style={s.photo} /> : <IconImage size={30} color={g.secondary} />}
          {uploading ? <View style={s.photoBusy}><ActivityIndicator color="#fff" /></View> : null}
        </Pressable>
        {f.photo_url ? <SettingsRow title={t('biz.item.photoRemove', 'Remover foto')} destructive onPress={() => set('photo_url')('')} /> : null}
      </SettingsGroup>
      <SettingsGroup>
        <Field label={t('biz.item.name', 'Nome')} value={f.name} onChangeText={set('name')} maxLength={120} />
        <Field label={t('biz.item.price', 'Preço')} value={f.price} onChangeText={set('price')} keyboardType="decimal-pad" placeholder="0,00" maxLength={12} />
        <Field label={t('biz.item.section', 'Seção (ex.: Pizzas, Bebidas)')} value={f.section} onChangeText={set('section')} maxLength={60} />
        <Field label={t('biz.item.desc', 'Descrição')} value={f.description} onChangeText={set('description')} multiline maxLength={500} />
        <SettingsSwitchRow title={t('biz.item.available', 'Disponível')} value={!!f.available} onValueChange={set('available')} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      <PrimaryButton title={t('biz.save', 'Salvar')} onPress={save} busy={busy} />
      {id ? <SettingsGroup style={{ marginTop: 16 }}><SettingsRow title={t('biz.item.del', 'Apagar')} destructive onPress={del} /></SettingsGroup> : null}
    </>
  );
}

// ─── pedidos ────────────────────────────────────────────────────────────────
const NEXT = { new: ['confirmed', 'cancelled'], confirmed: ['ready', 'cancelled'], ready: ['delivered', 'cancelled'] };
function Orders({ t }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [filter, setFilter] = useState('open');
  const [list, setList] = useState(null);
  const load = useCallback(async () => { const r = await B.ordersList(filter); setList(r.ok ? (r.data.orders || []) : []); }, [filter]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [filter, load]);
  const act = async (o, st) => {
    const r = await B.orderStatus(o.id, st);
    if (r.ok) setList((l) => l.map((x) => (x.id === o.id ? r.data.order : x)));
  };
  const actLabel = (st) => ({ confirmed: t('biz.order.confirm', 'Confirmar'), ready: t('biz.order.ready', 'Marcar pronto'), delivered: t('biz.order.delivered', 'Marcar entregue'), cancelled: t('biz.order.cancel', 'Cancelar') }[st]);
  return (
    <>
      <View style={[s.seg, { backgroundColor: g.fill }]} accessibilityRole="tablist">
        {[['open', t('biz.orders.open', 'Em aberto')], ['', t('biz.orders.all', 'Todos')]].map(([k, l]) => (
          <Pressable key={k || 'all'} onPress={() => setFilter(k)} style={[s.segItem, filter === k && { backgroundColor: g.ink }]} accessibilityRole="tab" accessibilityState={{ selected: filter === k }}>
            <Text style={{ color: filter === k ? g.onInk : g.text, fontWeight: '600' }}>{l}</Text>
          </Pressable>
        ))}
      </View>
      {!list ? <ActivityIndicator style={{ marginTop: 30 }} /> : null}
      {list && !list.length ? <Text style={[s.note, { color: g.secondary }]}>{t('biz.orders.empty', 'Nenhum pedido por aqui. Os pedidos anotados pela Bia aparecem nesta lista.')}</Text> : null}
      {(list || []).map((o) => (
        <SettingsGroup key={o.id} header={`#${o.id} · ${o.customer_name || o.customer_email}`}>
          <SettingsCardContent>
            {o.items.map((it, i) => (
              <Text key={i} style={[s.body, { color: g.text }]}>{`${it.qty}x ${it.name} — ${B.money(it.qty * it.unit_cents, o.currency)}${it.note ? ` (${it.note})` : ''}`}</Text>
            ))}
            <Text style={[s.body, { color: g.secondary, marginTop: 6 }]}>
              {o.fulfillment === 'delivery' ? `${t('biz.order.delivery', 'Entrega')}: ${o.address}` : t('biz.order.pickup', 'Retirada no local')}
            </Text>
            {o.note ? <Text style={[s.body, { color: g.secondary }]}>{o.note}</Text> : null}
            <Text style={[s.total, { color: g.text }]}>{`${t('biz.order.total', 'Total')}: ${B.money(o.total_cents, o.currency)}`}</Text>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}><Pill text={statusLabel(t, o.status)} /></View>
          </SettingsCardContent>
          {(NEXT[o.status] || []).map((st) => (
            <SettingsRow key={st} title={actLabel(st)} destructive={st === 'cancelled'} onPress={() => act(o, st)} />
          ))}
          <SettingsRow icon={IconMessageSquare} title={t('biz.order.openChat', 'Abrir conversa')} onPress={() => openConv(o.conversation_id, o.customer_name)} />
        </SettingsGroup>
      ))}
    </>
  );
}

// ─── mensagens automáticas + respostas rápidas ──────────────────────────────
function MessagesEdit({ t }) {
  const g = useGroupedColors();
  const [f, setF] = useState(null);
  const [sc, setSc] = useState(''); const [tx, setTx] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState(false);
  useEffect(() => { B.messagesGet().then((r) => setF(r.ok ? r.data : { greeting_on: false, greeting_msg: '', away_on: false, away_msg: '', quick_replies: [] })); }, []);
  if (!f) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const set = (k) => (v) => { setOk(false); setF((o) => ({ ...o, [k]: v })); };
  const save = async (next) => {
    setErr(''); setBusy(true);
    const r = await B.messagesSave(next || f);
    setBusy(false);
    if (!r.ok) setErr(r.error === 'greeting_empty' ? t('biz.msg.greetEmpty', 'Escreva a mensagem de saudação.') : r.error === 'away_empty' ? t('biz.msg.awayEmpty', 'Escreva a mensagem de ausência.') : errText(t, r.error));
    else setOk(true);
  };
  const addQr = () => {
    const shortcut = sc.trim().replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (!shortcut || !tx.trim()) return;
    const next = { ...f, quick_replies: [...(f.quick_replies || []).filter((q) => q.shortcut !== shortcut), { shortcut, text: tx.trim() }] };
    setF(next); setSc(''); setTx(''); save(next);
  };
  const delQr = (q) => { const next = { ...f, quick_replies: (f.quick_replies || []).filter((x) => x !== q) }; setF(next); save(next); };
  return (
    <>
      <SettingsGroup header={t('biz.msg.greeting', 'Mensagem de saudação')} footer={t('biz.msg.greetingFoot', 'Enviada quando um cliente fala com você pela primeira vez ou depois de 14 dias sem conversa.')}>
        <SettingsSwitchRow title={t('biz.msg.send', 'Enviar automaticamente')} value={!!f.greeting_on} onValueChange={set('greeting_on')} />
        <Field value={f.greeting_msg} onChangeText={set('greeting_msg')} multiline maxLength={600} placeholder={t('biz.msg.greetingPh', 'Olá! Obrigado por falar com a gente. Como podemos ajudar?')} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.msg.away', 'Mensagem de ausência')} footer={t('biz.msg.awayFoot', 'Enviada fora do horário de atendimento (no máximo uma vez a cada 12 horas por conversa).')}>
        <SettingsSwitchRow title={t('biz.msg.send', 'Enviar automaticamente')} value={!!f.away_on} onValueChange={set('away_on')} />
        <Field value={f.away_msg} onChangeText={set('away_msg')} multiline maxLength={600} placeholder={t('biz.msg.awayPh', 'Estamos fora do horário agora. Respondemos assim que abrirmos.')} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      {ok ? <Text style={[s.note, { color: g.secondary }]} accessibilityLiveRegion="polite">{t('biz.saved', 'Salvo')}</Text> : null}
      <PrimaryButton title={t('biz.save', 'Salvar')} onPress={() => save()} busy={busy} />
      <SettingsGroup style={{ marginTop: 24 }} header={t('biz.qr.title', 'Respostas rápidas')} footer={t('biz.qr.foot', 'Atalhos para respostas que você usa sempre (ex.: pix, horario).')}>
        {(f.quick_replies || []).map((q) => (
          <SettingsRow key={q.shortcut} title={`/${q.shortcut}`} subtitle={q.text} subtitleLines={3} right={
            <Pressable onPress={() => delQr(q)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('biz.item.del', 'Apagar')}><IconTrash size={18} color={g.destructive} /></Pressable>} />
        ))}
        <Field label={t('biz.qr.shortcut', 'Atalho')} value={sc} onChangeText={setSc} autoCapitalize="none" maxLength={24} />
        <Field label={t('biz.qr.text', 'Texto')} value={tx} onChangeText={setTx} multiline maxLength={1000} />
        <SettingsRow icon={IconPlus} title={t('biz.qr.add', 'Adicionar resposta rápida')} onPress={addQr} disabled={!sc.trim() || !tx.trim()} />
      </SettingsGroup>
    </>
  );
}

// ─── etiquetas ──────────────────────────────────────────────────────────────
const LABEL_COLORS = ['#34C759', '#007AFF', '#FF9500', '#FF2D55', '#AF52DE', '#5AC8FA', '#FFCC00', '#8E8E93'];
function LabelsEdit({ t }) {
  const g = useGroupedColors();
  const [list, setList] = useState(null);
  const [name, setName] = useState(''); const [color, setColor] = useState(LABEL_COLORS[0]);
  const load = useCallback(async () => { const r = await B.labelsList(); setList(r.ok ? r.data.labels : []); }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => { if (!name.trim()) return; await B.labelSave({ name: name.trim(), color }); setName(''); load(); };
  const del = (l) => safeAlert(t('biz.labels.del', 'Apagar etiqueta?'), l.name, [
    { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
    { text: t('biz.item.del', 'Apagar'), style: 'destructive', onPress: async () => { await B.labelDelete(l.id); load(); } },
  ]);
  if (!list) return <ActivityIndicator style={{ marginTop: 40 }} />;
  return (
    <>
      <SettingsGroup header={t('biz.labels.title', 'Etiquetas')} footer={t('biz.labels.foot', 'Use etiquetas como "Novo cliente", "Pedido pendente" ou "Pago" para organizar as conversas.')}>
        {list.map((l) => (
          <SettingsRow key={l.id} left={<View style={[s.dot, { backgroundColor: l.color }]} />} title={l.name} value={l.count ? String(l.count) : ''} onLongPress={() => del(l)} onPress={() => del(l)} chevron={false} />
        ))}
      </SettingsGroup>
      <SettingsGroup header={t('biz.labels.new', 'Nova etiqueta')}>
        <Field value={name} onChangeText={setName} maxLength={40} placeholder={t('biz.labels.ph', 'Nome da etiqueta')} />
        <SettingsCardContent style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {LABEL_COLORS.map((c) => (
            <Pressable key={c} onPress={() => setColor(c)} accessibilityRole="radio" accessibilityState={{ selected: color === c }} accessibilityLabel={c}
              style={[s.colorDot, { backgroundColor: c, borderColor: color === c ? g.text : 'transparent' }]} />
          ))}
        </SettingsCardContent>
        <SettingsRow icon={IconPlus} title={t('biz.labels.add', 'Adicionar etiqueta')} onPress={add} disabled={!name.trim()} />
      </SettingsGroup>
    </>
  );
}

// ─── Bia atendente ──────────────────────────────────────────────────────────
function BiaEdit({ t, onSaved }) {
  const router = useRouter();
  const g = useGroupedColors();
  const [b, setB] = useState(null);
  const [usage, setUsage] = useState(null);
  const [fee, setFee] = useState(''); const [min, setMin] = useState('');
  const [fq, setFq] = useState(''); const [fa, setFa] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { B.biaGet().then((r) => { if (r.ok) { setB(r.data.bia); setUsage(r.data.usage_today); setFee(B.centsToInput(r.data.bia.delivery_fee_cents)); setMin(B.centsToInput(r.data.bia.min_order_cents)); } }); }, []);
  if (!b) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const save = async (patch) => {
    setErr('');
    setB((o) => ({ ...o, ...patch }));
    const r = await B.biaSave(patch);
    if (r.ok) { setB(r.data.bia); onSaved && onSaved(); } else setErr(errText(t, r.error));
  };
  const tones = [['friendly', t('biz.tone.friendly', 'Amigável')], ['formal', t('biz.tone.formal', 'Formal')], ['casual', t('biz.tone.casual', 'Descontraído')], ['direct', t('biz.tone.direct', 'Objetivo')]];
  const whens = [['always', t('biz.when.always', 'Sempre')], ['outside_hours', t('biz.when.outside', 'Só fora do horário')], ['in_hours', t('biz.when.inside', 'Só no horário')]];
  const pauses = [['0', t('biz.pause.none', 'Não pausar')], ['1', t('biz.pause.h1', '1 hora')], ['2', t('biz.pause.h2', '2 horas')], ['8', t('biz.pause.h8', '8 horas')], ['24', t('biz.pause.h24', '24 horas')]];
  const addFaq = () => { if (!fq.trim() || !fa.trim()) return; save({ faq: [...(b.faq || []), { q: fq.trim(), a: fa.trim() }] }); setFq(''); setFa(''); };
  const delFaq = (i) => save({ faq: (b.faq || []).filter((_, j) => j !== i) });
  const openChat = async (menu) => {
    const r = await B.biaOpen(menu);
    if (r.ok && r.data.conversation_id) openConv(r.data.conversation_id, t('biz.botName', 'Configurar Bia'));
  };
  return (
    <>
      <SettingsGroup footer={t('biz.bia.rules', 'A Bia se apresenta como assistente virtual, usa só os dados do seu perfil, catálogo e perguntas frequentes, nunca inventa preço ou item e chama você quando não souber ou quando o cliente pedir uma pessoa. Ela não lê conversas com criptografia de ponta a ponta.')}>
        <SettingsSwitchRow icon={IconSparkles} title={t('biz.bia.on', 'Bia responde meus clientes')} value={!!b.enabled} onValueChange={(v) => save({ enabled: v })} />
        <SettingsPickerRow title={t('biz.bia.pause', 'Pausar')} value={b.paused ? '2' : '0'} onChange={(v) => save({ paused_hours: Number(v) })} options={pauses.map(([value, label]) => ({ value, label }))}
          displayValue={b.paused ? t('biz.bia.paused', 'Pausada') : t('biz.pause.none', 'Não pausar')} />
        <SettingsPickerRow title={t('biz.bia.tone', 'Tom')} value={b.tone} onChange={(v) => save({ tone: v })} options={tones.map(([value, label]) => ({ value, label }))} />
        <SettingsPickerRow title={t('biz.bia.when', 'Quando responder')} value={b.when_mode} onChange={(v) => save({ when_mode: v })} options={whens.map(([value, label]) => ({ value, label }))} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.bia.ordersH', 'Pedidos')}>
        <SettingsSwitchRow title={t('biz.bia.orders', 'Anotar pedidos pelo chat')} value={!!b.orders_on} onValueChange={(v) => save({ orders_on: v })} />
        <SettingsSwitchRow title={t('biz.bia.closed', 'Aceitar pedidos fora do horário')} value={!!b.orders_when_closed} onValueChange={(v) => save({ orders_when_closed: v })} />
        <SettingsSwitchRow title={t('biz.bia.delivery', 'Entrega')} value={!!b.delivery_on} onValueChange={(v) => save({ delivery_on: v })} />
        <SettingsSwitchRow title={t('biz.bia.pickup', 'Retirada no local')} value={!!b.pickup_on} onValueChange={(v) => save({ pickup_on: v })} />
        <Field label={t('biz.bia.fee', 'Taxa de entrega')} value={fee} onChangeText={setFee} keyboardType="decimal-pad" placeholder="0,00" />
        <Field label={t('biz.bia.min', 'Pedido mínimo')} value={min} onChangeText={setMin} keyboardType="decimal-pad" placeholder="0,00" />
        <Field label={t('biz.bia.area', 'Área de entrega')} value={b.delivery_area} onChangeText={(v) => setB((o) => ({ ...o, delivery_area: v }))} maxLength={300} />
        <SettingsRow title={t('biz.save', 'Salvar')} onPress={() => save({ delivery_fee_cents: B.parseMoney(fee) || 0, min_order_cents: B.parseMoney(min) || 0, delivery_area: b.delivery_area || '' })} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.bia.instr', 'Instruções para a Bia')}>
        <Field value={b.instructions} onChangeText={(v) => setB((o) => ({ ...o, instructions: v }))} multiline maxLength={1500} placeholder={t('biz.bia.instrPh', 'Ex.: Fale sempre do combo do dia. Pagamento por Pix ou cartão na entrega.')} />
        <SettingsRow title={t('biz.save', 'Salvar')} onPress={() => save({ instructions: b.instructions || '' })} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.bia.faq', 'Perguntas frequentes')}>
        {(b.faq || []).map((f, i) => (
          <SettingsRow key={i} title={f.q} subtitle={f.a} subtitleLines={3} right={
            <Pressable onPress={() => delFaq(i)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('biz.item.del', 'Apagar')}><IconTrash size={18} color={g.destructive} /></Pressable>} />
        ))}
        <Field label={t('biz.bia.faqQ', 'Pergunta')} value={fq} onChangeText={setFq} maxLength={200} />
        <Field label={t('biz.bia.faqA', 'Resposta')} value={fa} onChangeText={setFa} multiline maxLength={800} />
        <SettingsRow icon={IconPlus} title={t('biz.bia.faqAdd', 'Adicionar pergunta')} onPress={addFaq} disabled={!fq.trim() || !fa.trim()} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      <SettingsGroup header={t('biz.bia.chatH', 'Conversa "Configurar Bia"')} footer={usage ? t('biz.bia.usage', { defaultValue: 'Hoje: {n} respostas da Bia.', n: usage.replies }) : ''}>
        <SettingsRow icon={IconMessageSquare} title={t('biz.bia.chat', 'Configurar Bia pela conversa')} onPress={() => openChat(true)} />
        <SettingsRow icon={IconSparkles} title={t('biz.bia.test', 'Testar como cliente')} subtitle={t('biz.bia.testSub', 'Na conversa, mande "testar" e escreva como se fosse um cliente')} onPress={() => openChat(false)} />
      </SettingsGroup>
    </>
  );
}

// ─── vista pública (cliente) ────────────────────────────────────────────────
function PublicView({ email, t }) {
  const g = useGroupedColors();
  const { user } = useAuth() || {};
  const isMe = !!(user && user.email && email && String(user.email).toLowerCase() === String(email).toLowerCase());
  const [c, setC] = useState(undefined);
  useEffect(() => {
    (async () => {
      const r = await B.publicGet(email || '', true);
      setC(r.ok ? r.data.business : null);
    })();
  }, [email]);
  if (c === undefined) return <ActivityIndicator style={{ marginTop: 40 }} />;
  if (!c) return <Text style={[s.note, { color: g.secondary }]}>{t('biz.public.none', 'Esta conta não é comercial.')}</Text>;
  const openNow = c.open_now === true ? t('biz.public.open', 'Aberto agora') : c.open_now === false ? t('biz.public.closed', 'Fechado agora') : '';
  const map = () => { const q = encodeURIComponent(c.address || ''); if (q) Linking.openURL(Platform.OS === 'ios' ? `http://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {}); };
  return (
    <>
      <SettingsCardContent style={{ gap: 6 }}>
        <Text style={[s.lead, { color: g.text }]}>{c.name}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Pill text={t('biz.label', 'Conta comercial')} />
          {c.verified ? <Pill text={t('biz.verified', 'Verificada')} /> : null}
          {c.assistant_active ? <Pill text={t('biz.public.assistant', 'Atendimento com assistente')} /> : null}
        </View>
        {c.category ? <Text style={[s.body, { color: g.secondary }]}>{categoryLabel(t, c.category)}</Text> : null}
        {c.description ? <Text style={[s.body, { color: g.text }]}>{c.description}</Text> : null}
      </SettingsCardContent>
      {c.assistant_active ? <Text style={[s.note, { color: g.secondary }]}>{t('biz.public.assistantNote', 'Esta empresa usa a Bia, uma assistente automática, para atender. Conversas com a empresa não usam criptografia de ponta a ponta.')}</Text> : null}
      <SettingsGroup>
        {openNow ? <SettingsRow icon={IconClock} title={openNow} /> : null}
        {c.address ? <SettingsRow icon={IconMapPin} title={c.address} numberOfLines={2} onPress={map} /> : null}
        {c.website ? <SettingsRow icon={IconGlobe} title={c.website} onPress={() => Linking.openURL(c.website).catch(() => {})} /> : null}
        {c.contact_phone ? <SettingsRow icon={IconPhone} title={c.contact_phone} onPress={() => Linking.openURL(`tel:${c.contact_phone.replace(/[^0-9+]/g, '')}`).catch(() => {})} /> : null}
        {c.contact_email ? <SettingsRow icon={IconMail} title={c.contact_email} onPress={() => Linking.openURL(`mailto:${c.contact_email}`).catch(() => {})} /> : null}
        {c.cnpj_checked ? <SettingsRow icon={IconShield} title={t('biz.public.cnpj', 'CNPJ conferido na consulta pública')} /> : null}
      </SettingsGroup>
      {c.hours && c.hours.days ? (
        <SettingsGroup header={t('biz.f.hours', 'Horário de atendimento')}>
          {B.BIZ_DAYS.map((d) => <SettingsRow key={d} title={dayLabel(t, d)} value={(c.hours.days[d] || []).map((iv) => `${iv[0]}–${iv[1]}`).join(', ') || t('biz.hours.closed', 'Fechado')} />)}
        </SettingsGroup>
      ) : null}
      {(c.catalog || []).length ? (
        <SettingsGroup header={t('biz.catalog.title', 'Catálogo')}>
          {c.catalog.map((it) => (
            <SettingsRow key={it.id}
              left={it.photo_url ? <Image source={{ uri: it.photo_url }} style={s.thumb} /> : <View style={[s.thumb, { backgroundColor: g.fill }]} />}
              title={it.name} subtitle={`${B.money(it.price_cents, c.currency)}${it.available ? '' : ' · ' + t('biz.item.soldOut', 'Esgotado')}${it.description ? '\n' + it.description : ''}`} subtitleLines={3} />
          ))}
        </SettingsGroup>
      ) : null}
      {email && !isMe ? <PrimaryButton title={t('biz.public.chat', 'Conversar')} onPress={() => { try { require('../services/openConversation').openConversation(`/chat-conversation?name=${encodeURIComponent(c.name || email.split('@')[0])}&email=${encodeURIComponent(email)}`); } catch {} }} /> : null}
    </>
  );
}

const s = StyleSheet.create({
  lead: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  body: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 18, marginBottom: 14 },
  err: { fontSize: 14, lineHeight: 19, paddingHorizontal: 18, marginBottom: 12 },
  fieldLbl: { fontSize: 13, marginBottom: 6 },
  btn: { marginHorizontal: 16, minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  btnTxt: { fontSize: 16, fontWeight: '600' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pillTxt: { fontSize: 12, fontWeight: '600' },
  link: { alignSelf: 'center', padding: 12 },
  linkTxt: { fontSize: 14, fontWeight: '500' },
  thumb: { width: 40, height: 40, borderRadius: 8 },
  photoBox: { height: 180, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photo: { width: '100%', height: '100%' },
  photoBusy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  total: { fontSize: 15, fontWeight: '700', marginTop: 6 },
  seg: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 16, borderRadius: 10, padding: 2 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  colorDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2 },
});
