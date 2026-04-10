import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { IconPhone, IconMail } from './Icons';
import AvatarCircle from './AvatarCircle';

/**
 * Contact Message Component
 * Renders contact card with name, phone, email + action buttons
 * Parses JSON content: { name, phone, email, phone_type, email_type }
 */
export default function ContactMessage({ content, isOwn, colors = {}, t }) {
  // FIX: usar safeColors em TODO o componente (não misturar colors e safeColors)
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#007AFF',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  const [contact, setContact] = useState(null);

  React.useEffect(() => {
    try {
      const c = typeof content === 'string' ? JSON.parse(content) : content;
      setContact(c);
    } catch (err) {
      console.warn('ContactMessage parse error:', err);
    }
  }, [content]);

  if (!contact || !contact.name) {
    return (
      <View style={[styles.container, { backgroundColor: safeColors.surface }]}>
        <Text style={{ color: safeColors.textTertiary }}>👤 {t?.('chatConv.invalidContact') || 'Invalid contact'}</Text>
      </View>
    );
  }

  const handleCall = () => {
    if (contact.phone) {
      Linking.openURL(`tel:${contact.phone}`).catch(() => {});
    }
  };

  const handleEmail = () => {
    if (contact.email) {
      Linking.openURL(`mailto:${contact.email}`).catch(() => {});
    }
  };

  // FIX: cor com opacidade — evitar concatenação com undefined
  const primaryWithAlpha = safeColors.primary + '20';

  return (
    <View style={[styles.container, { backgroundColor: isOwn ? 'rgba(0,0,0,0.06)' : safeColors.surface }]}>
      {/* Contact Header with Avatar */}
      <View style={styles.header}>
        <AvatarCircle
          name={contact.name}
          size={42}
          style={{ marginRight: 10 }}
        />
        <View style={{ flex: 1 }}>
          <Text style={[styles.nameText, { color: isOwn ? '#fff' : safeColors.text }]}>
            {contact.name}
          </Text>
          {contact.phone && (
            <Text style={{ fontSize: 12, color: isOwn ? 'rgba(255,255,255,0.6)' : safeColors.textSecondary, marginTop: 1 }}>
              {contact.phone}
            </Text>
          )}
        </View>
      </View>

      {/* Action Buttons - WhatsApp style bottom bar */}
      <View style={[styles.actionBar, { borderTopColor: isOwn ? 'rgba(255,255,255,0.08)' : safeColors.border }]}>
        {contact.phone && (
          <TouchableOpacity
            onPress={handleCall}
            style={[styles.actionBtn, { backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : primaryWithAlpha }]}
            activeOpacity={0.7}
          >
            <IconPhone size={15} color={isOwn ? '#fff' : safeColors.primary} style={{ marginRight: 5 }} />
            <Text style={[styles.actionText, { color: isOwn ? '#fff' : safeColors.primary }]}>
              {t?.('chatConv.call') || 'Ligar'}
            </Text>
          </TouchableOpacity>
        )}

        {contact.email && (
          <TouchableOpacity
            onPress={handleEmail}
            style={[styles.actionBtn, { backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : primaryWithAlpha }]}
            activeOpacity={0.7}
          >
            <IconMail size={15} color={isOwn ? '#fff' : safeColors.primary} style={{ marginRight: 5 }} />
            <Text style={[styles.actionText, { color: isOwn ? '#fff' : safeColors.primary }]}>
              Email
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 200,
    maxWidth: 260,
    borderRadius: 12,
    overflow: 'hidden',
    paddingHorizontal: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  nameText: {
    fontSize: 14,
    fontWeight: '700',
  },
  actionBar: {
    flexDirection: 'row',
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 0,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
