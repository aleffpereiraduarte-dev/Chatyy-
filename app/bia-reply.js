// [conta-empresarial 2026-10-24] Configurações > "Bia responde por mim" (pessoa física, estilo Telegram).
// Quando você não pode responder, a Bia responde nas conversas 1:1 SEMPRE como "Resposta automática da Bia",
// anota recados e manda um resumo na conversa "Configurar Bia" quando você volta. Nunca assume compromissos
// nem fala de valores; nunca responde em grupo sem permissão (e só quando mencionarem você); nunca em
// conversa com criptografia de ponta a ponta. Servidor: biz_reply_get/biz_reply_save (chat_user_auto_reply.bia_*).
import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsCardContent,
  useGroupedColors, useSettingsInputStyle,
} from '../components/settings/SettingsKit';
import { IconSparkles, IconMessageSquare, IconTrash, IconPlus } from '../components/Icons';
import HoursEditor, { hoursValid } from '../components/business/HoursEditor';
import * as B from '../services/business';

function openConv(cid, name) {
  try { require('../services/openConversation').openConversation(`/chat-conversation?id=${encodeURIComponent(String(cid))}${name ? `&name=${encodeURIComponent(name)}` : ''}`); } catch {}
}

export default function BiaReplyScreen() {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const input = useSettingsInputStyle();
  const [st, setSt] = useState(null); // { enabled, cfg }
  const [avail, setAvail] = useState(true);
  const [instr, setInstr] = useState('');
  const [who, setWho] = useState('');
  const [notes, setNotes] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const s0 = await B.bizStatus();
      if (!s0.ok || !s0.data.enabled) { setAvail(false); return; }
      const r = await B.replyGet();
      if (r.ok) { setSt({ enabled: !!r.data.enabled, cfg: r.data.cfg }); setInstr(r.data.cfg.instructions || ''); }
      const n = await B.notesList();
      if (n.ok) setNotes(n.data.notes || []);
    })();
  }, []);

  const save = useCallback(async (patch) => {
    setErr('');
    setSt((o) => ({ enabled: patch.enabled !== undefined ? patch.enabled : o.enabled, cfg: { ...o.cfg, ...(patch.cfg || {}) } }));
    const r = await B.replySave(patch);
    if (r.ok) setSt({ enabled: !!r.data.enabled, cfg: r.data.cfg });
    else setErr(r.error === 'content_rejected' ? t('biz.err.content', 'Esse texto não pode ser usado (moderação). Tente com outras palavras.') : t('biz.err.generic', 'Não deu certo agora. Tente de novo.'));
  }, [t]);

  const title = t('biz.reply.title', 'Bia responde por mim');
  if (!avail) {
    return (
      <SettingsScreen title={title}>
        <SettingsGroup footer={t('biz.unavailable', 'A conta empresarial ainda não está disponível para a sua conta. Ela chega aos poucos para todos.')}>
          <SettingsRow icon={IconSparkles} title={title} subtitle={t('biz.soon', 'Em breve')} />
        </SettingsGroup>
      </SettingsScreen>
    );
  }
  if (!st) return <SettingsScreen title={title}><ActivityIndicator style={{ marginTop: 40 }} /></SettingsScreen>;
  const c = st.cfg;
  const whens = [
    ['always', t('biz.reply.when.always', 'Sempre')], ['offline', t('biz.reply.when.offline', 'Quando eu estiver offline')],
    ['outside_hours', t('biz.reply.when.outside', 'Fora do meu horário')], ['busy', t('biz.reply.when.busy', 'Modo ocupado')],
  ];
  const auds = [
    ['all', t('biz.reply.aud.all', 'Todos')], ['non_contacts', t('biz.reply.aud.nonContacts', 'Só quem não está nos meus contatos')],
    ['chosen', t('biz.reply.aud.chosen', 'Só pessoas escolhidas')], ['except', t('biz.reply.aud.except', 'Todos, menos as excluídas')],
  ];
  const cans = [['notes', t('biz.reply.can.notes', 'Só avisar e anotar recado')], ['answer', t('biz.reply.can.answer', 'Responder perguntas simples')]];
  const tones = [['friendly', t('biz.tone.friendly', 'Amigável')], ['formal', t('biz.tone.formal', 'Formal')], ['casual', t('biz.tone.casual', 'Descontraído')], ['direct', t('biz.tone.direct', 'Objetivo')]];
  const busyOpts = [['1', t('biz.pause.h1', '1 hora')], ['2', t('biz.pause.h2', '2 horas')], ['8', t('biz.pause.h8', '8 horas')], ['24', t('biz.pause.h24', '24 horas')]];
  const busyLeft = c.busy_until && new Date(c.busy_until).getTime() > Date.now();
  const addWho = () => {
    const e = who.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setErr(t('biz.err.email', 'E-mail inválido.')); return; }
    setWho('');
    save({ cfg: { list: [...(c.list || []).filter((x) => x !== e), e] } });
  };
  const openChat = async () => { const r = await B.biaOpen(true); if (r.ok && r.data.conversation_id) openConv(r.data.conversation_id, t('biz.botName', 'Configurar Bia')); };

  return (
    <SettingsScreen title={title}>
      <SettingsGroup footer={t('biz.reply.footer', 'Toda resposta começa com "Resposta automática da Bia". A Bia nunca assume compromissos, não fala de valores nem passa seus dados, não responde em grupos sem permissão e não lê conversas com criptografia de ponta a ponta.')}>
        <SettingsSwitchRow icon={IconSparkles} title={title} value={st.enabled} onValueChange={(v) => save({ enabled: v })} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.reply.whenH', 'Quando')}>
        <SettingsPickerRow title={t('biz.reply.when', 'Responder')} value={c.when} onChange={(v) => save({ cfg: { when: v, ...(v === 'busy' && !busyLeft ? { busy_until: Math.floor(Date.now() / 1000) + 2 * 3600 } : {}) } })}
          options={whens.map(([value, label]) => ({ value, label }))} />
        {c.when === 'busy' ? (
          <SettingsPickerRow title={t('biz.reply.busyFor', 'Ocupado por')} value="" onChange={(v) => save({ cfg: { busy_until: Math.floor(Date.now() / 1000) + Number(v) * 3600 } })}
            options={busyOpts.map(([value, label]) => ({ value, label }))}
            displayValue={busyLeft ? t('biz.reply.busyUntil', { defaultValue: 'até {t}', t: new Date(c.busy_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('biz.reply.busyOff', 'Terminou')} />
        ) : null}
      </SettingsGroup>
      {c.when === 'outside_hours' ? (
        <HoursEditor t={t} value={c.hours} onChange={(h) => { if (hoursValid(h)) save({ cfg: { hours: h } }); else setSt((o) => ({ ...o, cfg: { ...o.cfg, hours: h } })); }}
          header={t('biz.reply.hours', 'Meu horário (fora dele a Bia responde)')} />
      ) : null}
      <SettingsGroup header={t('biz.reply.whoH', 'Para quem')}>
        <SettingsPickerRow title={t('biz.reply.aud', 'Responder para')} value={c.audience} onChange={(v) => save({ cfg: { audience: v } })} options={auds.map(([value, label]) => ({ value, label }))} />
        {c.audience === 'chosen' || c.audience === 'except' ? (
          <>
            {(c.list || []).map((e) => (
              <SettingsRow key={e} title={e} right={
                <Pressable onPress={() => save({ cfg: { list: (c.list || []).filter((x) => x !== e) } })} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('biz.item.del', 'Apagar')}><IconTrash size={18} color={g.destructive} /></Pressable>} />
            ))}
            <SettingsCardContent>
              <TextInput style={input} value={who} onChangeText={setWho} placeholder={t('biz.reply.addPh', 'E-mail da pessoa')} placeholderTextColor={g.tertiary} autoCapitalize="none" keyboardType="email-address" accessibilityLabel={t('biz.reply.addPh', 'E-mail da pessoa')} />
            </SettingsCardContent>
            <SettingsRow icon={IconPlus} title={c.audience === 'chosen' ? t('biz.reply.addChosen', 'Adicionar pessoa') : t('biz.reply.addExcept', 'Excluir pessoa')} onPress={addWho} disabled={!who.trim()} />
          </>
        ) : null}
        <SettingsSwitchRow title={t('biz.reply.groups', 'Responder em grupos quando me mencionarem')} value={!!c.groups} onValueChange={(v) => save({ cfg: { groups: v } })} />
      </SettingsGroup>
      <SettingsGroup header={t('biz.reply.whatH', 'O que a Bia faz')}>
        <SettingsPickerRow title={t('biz.reply.can', 'A Bia pode')} value={c.can} onChange={(v) => save({ cfg: { can: v } })} options={cans.map(([value, label]) => ({ value, label }))} />
        <SettingsPickerRow title={t('biz.bia.tone', 'Tom')} value={c.tone} onChange={(v) => save({ cfg: { tone: v } })} options={tones.map(([value, label]) => ({ value, label }))} />
        <SettingsCardContent>
          <Text style={[s.lbl, { color: g.secondary }]}>{t('biz.reply.instr', 'Instruções')}</Text>
          <TextInput style={[input, { minHeight: 80, textAlignVertical: 'top' }]} value={instr} onChangeText={setInstr} multiline maxLength={600}
            placeholder={t('biz.reply.instrPh', 'Ex.: Diga que estou dirigindo. Responda em espanhol.')} placeholderTextColor={g.tertiary} accessibilityLabel={t('biz.reply.instr', 'Instruções')} />
        </SettingsCardContent>
        <SettingsRow title={t('biz.save', 'Salvar')} onPress={() => save({ cfg: { instructions: instr } })} disabled={instr === (c.instructions || '')} />
        <SettingsSwitchRow title={t('biz.reply.summary', 'Resumo dos recados quando eu voltar')} value={c.summary !== false} onValueChange={(v) => save({ cfg: { summary: v } })} />
      </SettingsGroup>
      {err ? <Text style={[s.err, { color: g.destructive }]}>{err}</Text> : null}
      <SettingsGroup header={t('biz.reply.notes', 'Recados')}>
        {!notes.length ? <SettingsRow title={t('biz.reply.notesEmpty', 'Nenhum recado ainda')} /> : null}
        {notes.slice(0, 20).map((n) => (
          <SettingsRow key={n.id} title={n.from_name || n.from_email} subtitle={n.text} subtitleLines={3}
            onPress={() => openConv(n.conversation_id, n.from_name)} />
        ))}
        <SettingsRow icon={IconMessageSquare} title={t('biz.bia.chat', 'Configurar Bia pela conversa')} onPress={openChat} />
      </SettingsGroup>
    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  lbl: { fontSize: 13, marginBottom: 6 },
  err: { fontSize: 14, lineHeight: 19, paddingHorizontal: 18, marginBottom: 12 },
});
