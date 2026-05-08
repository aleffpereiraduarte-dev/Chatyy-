/**
 * KidsAskParentModal — lets a kid ask their parent for something.
 *
 * Four quick types: more screen time, new contact, app access, or "other".
 * POSTs to /api/?action=kids_ask_parent which creates a pending request +
 * fires a push to all the kid's guardians. Parent sees it in the parental
 * dashboard (parentalPendingRequests) and approves/denies.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView, ActivityIndicator,
  Animated, Platform, StyleSheet,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as api from '../services/api';

function IconX({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  );
}

function IconClock({ size = 16, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 5v5l3 2" />
    </Svg>
  );
}

function IconCheck({ size = 16, color = '#10b981' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

function IconBack({ size = 18, color = '#A78BFA' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19 12H5M12 19l-7-7 7-7" />
    </Svg>
  );
}

const REQUEST_TYPES = [
  { key: 'extra_time',  emoji: '⏰', color: '#f97316', name: 'Mais tempo no app',       desc: 'Peça mais minutos pro seu pai ou mãe' },
  { key: 'new_contact', emoji: '👥', color: '#10b981', name: 'Aprovar novo contato',    desc: 'Adicionar um amigo novo' },
  { key: 'new_app',     emoji: '📱', color: '#A78BFA', name: 'Liberar novo app',        desc: 'Usar um app que está bloqueado' },
  { key: 'help',        emoji: '🆘', color: '#ef4444', name: 'Preciso de ajuda',        desc: 'Mandar alerta importante' },
  { key: 'other',       emoji: '💬', color: '#8b5cf6', name: 'Outro pedido',            desc: 'Escrever do seu jeito' },
];

export default function KidsAskParentModal({ visible, onClose, isDark, t }) {
  const [type, setType] = useState(null);
  const [message, setMessage] = useState('');
  const [extraMinutes, setExtraMinutes] = useState(30);
  const [contactEmail, setContactEmail] = useState('');
  const [appName, setAppName] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // History drawer state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      setType(null); setMessage(''); setSent(false);
      setExtraMinutes(30); setContactEmail(''); setAppName('');
      setHistoryOpen(false);
    } else {
      fade.setValue(0);
    }
  }, [visible]);

  const loadHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      // Backend: kids_my_requests already exists in services/api.js
      const r = await api.kidsMyRequests?.();
      const items = r?.data?.requests || r?.requests || [];
      setHistoryItems(Array.isArray(items) ? items : []);
    } catch {
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSend = async () => {
    if (!type || sending) return;
    setSending(true);
    try {
      const extras = {};
      if (type === 'extra_time') extras.extra_minutes = extraMinutes;
      if (type === 'new_contact') extras.contact_email = contactEmail.trim();
      if (type === 'new_app') extras.app = appName.trim();
      const r = await api.kidsAskParent(type, message.trim(), extras);
      if (r?.success) {
        setSent(true);
        setTimeout(() => { onClose?.(); }, 1800);
      } else {
        // fall through — keep form open so kid can retry
      }
    } catch {} finally { setSending(false); }
  };

  const activeType = REQUEST_TYPES.find(r => r.key === type);

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
        <Animated.View style={{
          opacity: fade,
          backgroundColor: isDark ? '#0f0720' : '#fff',
          borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '92%',
        }}>
          {/* Gradient header */}
          <View style={[styles.header, Platform.OS === 'web'
            ? { background: 'linear-gradient(135deg, #10b981 0%, #A78BFA 60%, #8b5cf6 100%)' }
            : { backgroundColor: '#A78BFA' },
          ]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>
                {t?.('kids.askParent.title') || 'Falar com meus pais'}
              </Text>
              <Text style={styles.headerSub}>
                {t?.('kids.askParent.sub') || 'Manda um pedido pro seu responsável'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Fechar">
              <IconX size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {sent ? (
            <View style={{ padding: 36, alignItems: 'center' }}>
              <Text style={{ fontSize: 60, marginBottom: 10 }}>✅</Text>
              <Text style={{ fontSize: 20, fontWeight: '800', color: isDark ? '#a7f3d0' : '#065f46', textAlign: 'center' }}>
                {t?.('kids.askParent.sent') || 'Pedido enviado!'}
              </Text>
              <Text style={{ marginTop: 8, fontSize: 14, color: isDark ? '#6ee7b7' : '#047857', textAlign: 'center' }}>
                {t?.('kids.askParent.waiting') || 'Agora é só esperar a resposta do seu pai ou mãe.'}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                activeOpacity={0.85}
                style={{
                  marginTop: 24, paddingVertical: 12, paddingHorizontal: 32,
                  borderRadius: 14, backgroundColor: '#10b981',
                }}
                accessibilityRole="button"
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>
                  {t?.('common.back') || 'Voltar'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : historyOpen ? (
          <View>
            {/* History sub-header */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingHorizontal: 16, paddingVertical: 12,
              borderBottomWidth: 1, borderBottomColor: isDark ? '#2d1b4e' : '#f3e8ff',
            }}>
              <TouchableOpacity onPress={() => setHistoryOpen(false)} accessibilityRole="button" accessibilityLabel="Voltar">
                <IconBack size={20} color={isDark ? '#A78BFA' : '#7C3AED'} />
              </TouchableOpacity>
              <Text style={{ fontSize: 15, fontWeight: '800', color: isDark ? '#e9d5ff' : '#1e1b4b' }}>
                {t?.('kids.askParent.history') || 'Pedidos anteriores'}
              </Text>
            </View>

            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
              {historyLoading ? (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                  <ActivityIndicator color="#A78BFA" />
                </View>
              ) : historyItems.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ fontSize: 40, marginBottom: 8 }}>📭</Text>
                  <Text style={{ fontSize: 14, color: isDark ? '#9ca3af' : '#6b7280', textAlign: 'center' }}>
                    {t?.('kids.askParent.empty') || 'Você ainda não fez nenhum pedido.'}
                  </Text>
                </View>
              ) : (
                historyItems.map((item, idx) => {
                  // Map decision/status to label + color
                  const status = (item.status || item.decision || 'pending').toLowerCase();
                  const isApproved = status === 'approved' || status === 'granted';
                  const isDenied = status === 'denied' || status === 'rejected';
                  const statusColor = isApproved ? '#10b981' : isDenied ? '#ef4444' : '#f59e0b';
                  const statusLabel = isApproved
                    ? (t?.('kids.askParent.approved') || 'Aprovado')
                    : isDenied
                      ? (t?.('kids.askParent.denied') || 'Negado')
                      : (t?.('kids.askParent.pending') || 'Pendente');
                  const matchType = REQUEST_TYPES.find(rt =>
                    rt.key === item.type || rt.key === item.reason
                  );
                  const ts = item.created_at || item.requested_at || item.ts;
                  let timeStr = '';
                  if (ts) {
                    try {
                      const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
                      if (!isNaN(d.getTime())) timeStr = d.toLocaleString();
                    } catch {}
                  }
                  return (
                    <View
                      key={item.id || idx}
                      style={{
                        flexDirection: 'row', alignItems: 'flex-start', gap: 12,
                        padding: 14, marginBottom: 10, borderRadius: 16,
                        borderWidth: 1,
                        borderColor: isDark ? '#2d1b4e' : '#e5e7eb',
                        backgroundColor: isDark ? '#1a0f30' : '#fafafa',
                      }}
                    >
                      <View style={{
                        width: 38, height: 38, borderRadius: 12,
                        backgroundColor: (matchType?.color || '#8b5cf6') + '25',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Text style={{ fontSize: 20 }}>{matchType?.emoji || '💬'}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: isDark ? '#e9d5ff' : '#111' }}>
                          {matchType?.name || item.reason || item.type || '—'}
                        </Text>
                        {!!item.note && (
                          <Text style={{ fontSize: 13, color: isDark ? '#c4b5fd' : '#475569', marginTop: 4 }} numberOfLines={2}>
                            {item.note}
                          </Text>
                        )}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                          <View style={{
                            paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
                            backgroundColor: statusColor + '22', flexDirection: 'row', alignItems: 'center', gap: 4,
                          }}>
                            {isApproved && <IconCheck size={11} color={statusColor} />}
                            <Text style={{ fontSize: 11, fontWeight: '700', color: statusColor }}>
                              {statusLabel}
                            </Text>
                          </View>
                          {!!timeStr && (
                            <Text style={{ fontSize: 11, color: isDark ? '#7c6ba6' : '#9ca3af' }}>
                              {timeStr}
                            </Text>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
          ) : (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 28 }}>
            {/* Type picker */}
            <View style={{ padding: 16 }}>
              <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280' }]}>
                {t?.('kids.askParent.pickType') || 'O que você quer pedir?'}
              </Text>
              <View style={{ gap: 10 }}>
                {REQUEST_TYPES.map(rt => {
                  const selected = type === rt.key;
                  return (
                    <TouchableOpacity
                      key={rt.key}
                      onPress={() => setType(rt.key)}
                      activeOpacity={0.85}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 12,
                        paddingHorizontal: 14, paddingVertical: 14,
                        borderRadius: 18, borderWidth: 2,
                        borderColor: selected ? rt.color : (isDark ? '#2d1b4e' : '#e5e7eb'),
                        backgroundColor: selected ? rt.color + '18' : (isDark ? '#1a0f30' : '#fafafa'),
                      }}
                    >
                      <View style={{
                        width: 48, height: 48, borderRadius: 16,
                        backgroundColor: rt.color + '25',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Text style={{ fontSize: 26 }}>{rt.emoji}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: selected ? rt.color : (isDark ? '#e9d5ff' : '#111') }}>
                          {rt.name}
                        </Text>
                        <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginTop: 2 }}>
                          {rt.desc}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Type-specific fields */}
            {type === 'extra_time' && (
              <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
                <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280' }]}>
                  {t?.('kids.askParent.howMuch') || 'Quantos minutos a mais?'}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {[15, 30, 60, 90].map(m => {
                    const sel = extraMinutes === m;
                    return (
                      <TouchableOpacity
                        key={m}
                        onPress={() => setExtraMinutes(m)}
                        activeOpacity={0.85}
                        style={{
                          paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14,
                          backgroundColor: sel ? '#f97316' : (isDark ? '#2d1b4e' : '#fef3c7'),
                        }}
                      >
                        <Text style={{ fontSize: 15, fontWeight: '800', color: sel ? '#fff' : '#92400e' }}>
                          +{m} min
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}
            {type === 'new_contact' && (
              <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
                <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280' }]}>
                  {t?.('kids.askParent.contactEmail') || 'Email do contato'}
                </Text>
                <TextInput
                  value={contactEmail} onChangeText={setContactEmail}
                  placeholder="amigo@chatyy.com.br" placeholderTextColor={isDark ? '#6b5895' : '#a78bfa'}
                  keyboardType="email-address" autoCapitalize="none"
                  style={[styles.input, {
                    backgroundColor: isDark ? '#2d1b4e' : '#f3e8ff',
                    color: isDark ? '#e9d5ff' : '#1e1b4b',
                  }]}
                />
              </View>
            )}
            {type === 'new_app' && (
              <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
                <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280' }]}>
                  {t?.('kids.askParent.appName') || 'Qual app?'}
                </Text>
                <TextInput
                  value={appName} onChangeText={setAppName}
                  placeholder={t?.('kids.askParent.appHint') || 'Ex: YouTube, Roblox'} placeholderTextColor={isDark ? '#6b5895' : '#a78bfa'}
                  style={[styles.input, {
                    backgroundColor: isDark ? '#2d1b4e' : '#f3e8ff',
                    color: isDark ? '#e9d5ff' : '#1e1b4b',
                  }]}
                />
              </View>
            )}

            {/* Optional message + character counter */}
            {type && (
              <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280', marginBottom: 0 }]}>
                    {t?.('kids.askParent.why') || 'Quer explicar? (opcional)'}
                  </Text>
                  <Text style={{ fontSize: 11, color: isDark ? '#7c6ba6' : '#a78bfa', fontWeight: '600' }}>
                    {message.length}/500
                  </Text>
                </View>
                <TextInput
                  value={message} onChangeText={setMessage}
                  placeholder={t?.('kids.askParent.messageHint') || 'Escreve aqui…'}
                  placeholderTextColor={isDark ? '#6b5895' : '#a78bfa'}
                  multiline numberOfLines={3} maxLength={500}
                  style={[styles.input, {
                    backgroundColor: isDark ? '#2d1b4e' : '#f3e8ff',
                    color: isDark ? '#e9d5ff' : '#1e1b4b',
                    minHeight: 80, textAlignVertical: 'top', paddingTop: 12,
                  }]}
                />
              </View>
            )}

            {/* Ver pedidos anteriores — links para histórico */}
            <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
              <TouchableOpacity
                onPress={loadHistory}
                activeOpacity={0.7}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  gap: 8, paddingVertical: 10,
                }}
                accessibilityRole="button"
                accessibilityLabel={t?.('kids.askParent.history') || 'Ver pedidos anteriores'}
              >
                <IconClock size={14} color={isDark ? '#A78BFA' : '#7C3AED'} />
                <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#A78BFA' : '#7C3AED' }}>
                  {t?.('kids.askParent.history') || 'Ver pedidos anteriores'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Send button */}
            {type && (
              <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
                <TouchableOpacity
                  disabled={!type || sending || (type === 'new_contact' && !contactEmail.trim()) || (type === 'new_app' && !appName.trim())}
                  onPress={handleSend}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: activeType?.color || '#8b5cf6',
                    opacity: ((!type || sending || (type === 'new_contact' && !contactEmail.trim()) || (type === 'new_app' && !appName.trim())) ? 0.5 : 1),
                    borderRadius: 18, paddingVertical: 16, alignItems: 'center',
                    ...(Platform.OS === 'web' ? { boxShadow: `0 6px 18px ${activeType?.color || '#8b5cf6'}55` } : {}),
                  }}
                >
                  {sending
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                        {t?.('kids.askParent.send') || 'Enviar pedido'}
                      </Text>}
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 20,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
  },
  headerTitle: { fontSize: 21, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: '600', marginTop: 2 },
  closeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  input: {
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, fontWeight: '500',
  },
});
