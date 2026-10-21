// components/chat/ContactCardSheet.js — [2026-10-17 share-contact] Detalhes do
// cartão de contato (toque no cartão / "Ver todos"), estilo WhatsApp, P&B:
// cada contato com avatar, nome, "No Chatyy", todos os números e as ações
// Mensagem · Ligar · Salvar contato · Convidar.
//
// Imperativo: openContactCard(payloadOrMsg) — host (ContactCardHost) montado
// uma vez no app/_layout (Late overlays), mesmo padrão do PollVotesSheet.
// Sem host (ou kill switch globalThis.__chatyy_contact_sheet = false) devolve
// false e o chamador segue o comportamento antigo. Toda ação FECHA a folha
// antes (formulário do sistema / navegação nunca sobre o Modal).
import { useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useGroupedColors } from '../settings/SettingsKit';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconMessageCircle, IconPhone, IconUserPlus, IconShare, IconSend } from '../Icons';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragFade } from '../ui/useDragToDismiss';
import {
  parseContactPayload, chatyyStateSync, resolveChatyy, openChatWith, callContact,
  saveToPhonebook, inviteContact, prettyPhone,
} from './contactShare';

const _hosts = new Set();
function _enabled() { try { return globalThis.__chatyy_contact_sheet !== false; } catch { return true; } }
function _tr(t, k, fb) { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } }

/** Abre a folha; false = sem host/kill switch (use o fluxo antigo). */
export function openContactCard(src) {
  if (!_enabled() || !_hosts.size) return false;
  const parsed = parseContactPayload(src);
  if (!parsed.count) return false;
  const req = { parsed, at: Date.now() };
  _hosts.forEach((fn) => { try { fn(req); } catch {} });
  return true;
}

export default function ContactCardHost() {
  const [req, setReq] = useState(null);
  useEffect(() => {
    _hosts.add(setReq);
    return () => { _hosts.delete(setReq); };
  }, []);
  if (!req) return null;
  return <ContactCardSheet key={req.at} req={req} onClose={() => setReq(null)} />;
}

function _pstnOn() { try { return require('../../constants/featureFlags').isPstnEnabled() === true; } catch { return false; } }

function ContactCardSheet({ req, onClose }) {
  const drag = useDragToDismiss({ onDismiss: () => { if (typeof onClose === 'function') onClose(); } });
  const g = useGroupedColors();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const list = req.parsed.list;
  const [state, setState] = useState(() => list.map((c) => chatyyStateSync(c) || { loading: true, has: false, email: c.email }));

  useEffect(() => {
    let alive = true;
    list.forEach((c, i) => {
      if (state[i] && !state[i].loading) return;
      resolveChatyy(c).then((r) => {
        if (!alive) return;
        setState((prev) => prev.map((x, j) => (j === i ? { loading: false, has: !!r.has, email: r.email || c.email } : x)));
      });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const router = (() => { try { return require('expo-router').router; } catch { return null; } })();
  // Fecha e só depois age (Modal desce → formulário do sistema / nova tela).
  const go = (fn) => { onClose(); setTimeout(() => { try { fn(); } catch {} }, 380); };
  const pstn = _pstnOn();
  const title = list.length > 1
    ? _tr(t, 'shareContact.nContacts', '{n} contatos').split('{n}').join(String(list.length))
    : _tr(t, 'chatConv.contact', 'Contato');

  const Action = ({ icon: Ico, label, onPress, testID }) => (
    <Pressable onPress={onPress} style={({ pressed }) => [s.action, { backgroundColor: g.fill, opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Ico size={20} color={g.ink} />
      <Text style={[s.actionText, { color: g.ink }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot>
        <View style={s.root}>
          <DragFade drag={drag}><Pressable style={s.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.close', 'Fechar')} /></DragFade>
          <DragPanel drag={drag} style={[s.panel, { backgroundColor: g.pageBg, paddingBottom: 12 + insets.bottom }]} testID="contact-card-sheet">
            <View style={[s.grabber, { backgroundColor: g.tertiary }]} />
            <View style={s.header}>
              <View style={s.hBtn} />
              <Text style={[s.hTitle, { color: g.text }]} numberOfLines={1}>{title}</Text>
              <Pressable onPress={onClose} hitSlop={12} style={s.hBtn} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.close', 'Fechar')} testID="contact-card-close">
                <IconX size={22} color={g.ink} />
              </Pressable>
            </View>
            <DragScroll drag={drag}><ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}>
              {list.map((c, i) => {
                const st = state[i] || { loading: true, has: false };
                const em = st.email || c.email;
                const canCall = pstn ? !!c.phone : (!st.loading && st.has && !!em);
                return (
                  <View key={i} style={[s.card, { backgroundColor: g.cardBg }]}>
                    <View style={s.top}>
                      <AvatarCircle name={c.name} email={st.has ? em : (c.email || undefined)} uri={c.avatar || undefined} size={56} />
                      <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                        <Text style={[s.name, { color: g.text }]} numberOfLines={2}>{c.name}</Text>
                        {st.loading
                          ? <ActivityIndicator size="small" color={g.secondary} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                          : <Text style={[s.meta, { color: g.secondary }]}>{st.has ? _tr(t, 'shareContact.onChatyy', 'No Chatyy') : _tr(t, 'shareContact.notOnChatyy', 'Ainda não usa o Chatyy')}</Text>}
                      </View>
                    </View>
                    {c.phones.map((p) => (
                      <View key={p} style={[s.line, { borderTopColor: g.separator }]}>
                        <Text style={[s.lineLabel, { color: g.secondary }]}>{_tr(t, 'shareContact.phone', 'Telefone')}</Text>
                        <Text style={[s.lineValue, { color: g.text }]} selectable>{prettyPhone(p)}</Text>
                      </View>
                    ))}
                    {c.email && !st.has ? (
                      <View style={[s.line, { borderTopColor: g.separator }]}>
                        <Text style={[s.lineLabel, { color: g.secondary }]}>E-mail</Text>
                        <Text style={[s.lineValue, { color: g.text }]} selectable>{c.email}</Text>
                      </View>
                    ) : null}
                    <View style={s.actions}>
                      {st.has ? <Action icon={IconMessageCircle} label={_tr(t, 'chatConv.sendMessage', 'Mensagem')} onPress={() => go(() => openChatWith(c, router, em))} testID={`contact-card-msg-${i}`} /> : null}
                      {canCall ? <Action icon={IconPhone} label={_tr(t, 'chatConv.callContact', 'Ligar')} onPress={() => go(() => callContact(c, router, t, st.has ? em : ''))} testID={`contact-card-call-${i}`} /> : null}
                      <Action icon={IconUserPlus} label={_tr(t, 'shareContact.save', 'Salvar contato')} onPress={() => go(() => saveToPhonebook(c, t))} testID={`contact-card-save-${i}`} />
                      {/* [2026-10-17 share-contact] Encaminhar este contato para outra(s) conversa(s), como no WhatsApp. */}
                      <Action icon={IconSend} label={_tr(t, 'shareContact.shareThis', 'Compartilhar contato')} onPress={() => go(() => { try { const p = require('./contactShare').buildContactPayload([c]); if (p && router) router.push({ pathname: '/share-receive', params: { contact: p } }); } catch {} })} testID={`contact-card-share-${i}`} />
                      {!st.loading && !st.has ? <Action icon={IconShare} label={_tr(t, 'chat.invite', 'Convidar')} onPress={() => go(() => inviteContact(c, t))} testID={`contact-card-invite-${i}`} /> : null}
                    </View>
                  </View>
                );
              })}
            </ScrollView></DragScroll>
          </DragPanel>
        </View>
      </DragSheetRoot>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { maxHeight: '86%', borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden', width: '100%', maxWidth: 640, alignSelf: 'center' },
  grabber: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 8, opacity: 0.8 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  hBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  card: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 14, marginTop: 12 },
  top: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  meta: { fontSize: 13, marginTop: 3 },
  line: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginTop: 10 },
  lineLabel: { fontSize: 12 },
  lineValue: { fontSize: 15.5, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  action: { flexGrow: 1, flexBasis: '22%', minWidth: 72, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: 12.5, fontWeight: '600', marginTop: 5 },
});
