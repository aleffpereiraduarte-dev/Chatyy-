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
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      setType(null); setMessage(''); setSent(false);
      setExtraMinutes(30); setContactEmail(''); setAppName('');
    } else {
      fade.setValue(0);
    }
  }, [visible]);

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

            {/* Optional message */}
            {type && (
              <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
                <Text style={[styles.sectionLabel, { color: isDark ? '#c4b5fd' : '#6b7280' }]}>
                  {t?.('kids.askParent.why') || 'Quer explicar? (opcional)'}
                </Text>
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
