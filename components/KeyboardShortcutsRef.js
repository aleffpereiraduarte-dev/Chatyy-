/**
 * KeyboardShortcutsRef — reference overlay showing every hotkey in the app.
 * Opens with "?" on web. Standalone — doesn't replace the existing
 * KeyboardShortcutsModal (which is email-specific and more detailed).
 *
 * Grouped by category so users can scan for what they need without
 * reading a wall of text.
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, ScrollView,
  Platform, StyleSheet,
} from 'react-native';
import { IconX } from './Icons';

const WEB = Platform.OS === 'web';

// macOS uses ⌘, Windows/Linux use Ctrl. Detect once at render time.
const cmd = (() => {
  if (!WEB || typeof navigator === 'undefined') return 'Ctrl';
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  return isMac ? '⌘' : 'Ctrl';
})();

function Key({ children, colors }) {
  return (
    <View style={{
      paddingHorizontal: 7, paddingVertical: 2,
      borderRadius: 5, borderWidth: 1, borderColor: colors?.border || '#e5e7eb',
      backgroundColor: colors?.surface || '#f9fafb',
      minWidth: 22, alignItems: 'center',
    }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: colors?.text || '#111', fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>
        {children}
      </Text>
    </View>
  );
}

function Row({ keys, label, colors }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 18, paddingVertical: 9,
    }}>
      <Text style={{ fontSize: 13.5, color: colors?.text || '#111', flex: 1 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {keys.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text style={{ fontSize: 11, color: colors?.textTertiary || '#999' }}>+</Text>}
            <Key colors={colors}>{k}</Key>
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

function Section({ title, children, colors }) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={{
        fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
        color: colors?.textSecondary || '#666', paddingHorizontal: 18, paddingVertical: 6,
        letterSpacing: 0.5,
      }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export default function KeyboardShortcutsRef({ visible, onClose, colors, isDark, t }) {
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            backgroundColor: colors?.background || '#fff',
            borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '85%',
            overflow: 'hidden',
            ...(WEB ? { boxShadow: '0 24px 64px rgba(0,0,0,0.3)' } : { elevation: 12 }),
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 10 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors?.text }}>
              {t?.('shortcuts.title') || 'Atalhos do teclado'}
            </Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <IconX size={22} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 18 }}>
            <Section title={t?.('shortcuts.global') || 'Global'} colors={colors}>
              <Row keys={[cmd, 'K']} label={t?.('shortcuts.search') || 'Buscar'} colors={colors} />
              <Row keys={[cmd, 'N']} label={t?.('shortcuts.compose') || 'Novo'} colors={colors} />
              <Row keys={['?']}      label={t?.('shortcuts.thisMenu') || 'Esta lista'} colors={colors} />
              <Row keys={['Esc']}    label={t?.('shortcuts.close') || 'Fechar modal'} colors={colors} />
            </Section>

            <Section title={t?.('shortcuts.email') || 'Email'} colors={colors}>
              <Row keys={['J']} label={t?.('shortcuts.next') || 'Próximo email'} colors={colors} />
              <Row keys={['K']} label={t?.('shortcuts.prev') || 'Email anterior'} colors={colors} />
              <Row keys={['R']} label={t?.('shortcuts.reply') || 'Responder'} colors={colors} />
              <Row keys={['A']} label={t?.('shortcuts.replyAll') || 'Responder a todos'} colors={colors} />
              <Row keys={['F']} label={t?.('shortcuts.forward') || 'Encaminhar'} colors={colors} />
              <Row keys={['E']} label={t?.('shortcuts.archive') || 'Arquivar'} colors={colors} />
              <Row keys={['#']} label={t?.('shortcuts.delete') || 'Apagar'} colors={colors} />
              <Row keys={['U']} label={t?.('shortcuts.markUnread') || 'Marcar como não lido'} colors={colors} />
              <Row keys={['/']} label={t?.('shortcuts.focusSearch') || 'Focar busca'} colors={colors} />
            </Section>

            <Section title={t?.('shortcuts.compose_') || 'Escrevendo'} colors={colors}>
              <Row keys={[cmd, 'Enter']} label={t?.('shortcuts.send') || 'Enviar'} colors={colors} />
              <Row keys={[cmd, 'S']}     label={t?.('shortcuts.saveDraft') || 'Salvar rascunho'} colors={colors} />
            </Section>

            <Section title={t?.('shortcuts.chat') || 'Chat'} colors={colors}>
              <Row keys={['Enter']}        label={t?.('shortcuts.sendMsg') || 'Enviar mensagem'} colors={colors} />
              <Row keys={['Shift', 'Enter']} label={t?.('shortcuts.newLine') || 'Nova linha'} colors={colors} />
            </Section>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
