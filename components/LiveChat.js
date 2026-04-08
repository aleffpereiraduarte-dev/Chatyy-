import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, Platform, KeyboardAvoidingView, Animated,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconSend } from './Icons';

const MAX_VISIBLE = 100;
const ACCENT = '#25D366';

// Generate consistent color from name string
function nameColor(name) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', '#FF9FF3', '#54A0FF', '#5F27CD', '#01A3A4', '#F368E0'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function ChatMessage({ item }) {
  if (item.type === 'system') {
    return (
      <View style={styles.systemMsg}>
        <View style={styles.systemPill}>
          <Text style={styles.systemText}>{item.name} {item.content}</Text>
        </View>
      </View>
    );
  }

  const color = nameColor(item.name);

  return (
    <View style={styles.msgRow}>
      <AvatarCircle name={item.name} email={item.email} size={28} />
      <View style={styles.msgBubble}>
        <Text style={[styles.msgName, { color }]} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.msgText}>{item.content}</Text>
      </View>
    </View>
  );
}

const MemoizedMessage = React.memo(ChatMessage);

export default function LiveChat({ messages, onSend, style, placeholder, t }) {
  const flatListRef = useRef(null);
  const [inputText, setInputText] = useState('');
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Limit visible messages
  const visibleMessages = messages.length > MAX_VISIBLE
    ? messages.slice(-MAX_VISIBLE)
    : messages;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (visibleMessages.length > 0 && flatListRef.current) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd?.({ animated: true });
      }, 80);
    }
  }, [visibleMessages.length]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    onSend(text);
    setInputText('');
  }, [inputText, onSend]);

  const renderMessage = useCallback(({ item }) => (
    <MemoizedMessage item={item} />
  ), []);

  const isWeb = Platform.OS === 'web';
  const Wrapper = isWeb ? View : KeyboardAvoidingView;
  const wrapperProps = isWeb ? {} : { behavior: Platform.OS === 'ios' ? 'padding' : undefined };

  return (
    <Wrapper style={[styles.container, style]} {...wrapperProps}>
      {/* Gradient fade at top */}
      <View style={styles.gradientTop} pointerEvents="none" />

      <Animated.View style={[styles.listWrapper, { opacity: fadeAnim }]}>
        <FlatList
          ref={flatListRef}
          data={visibleMessages}
          renderItem={renderMessage}
          keyExtractor={(item, idx) => item.id || String(idx)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          inverted={false}
        />
      </Animated.View>

      <View style={styles.inputRow}>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder={placeholder || (t ? t('live.sendMessage') : 'Send a message...')}
            placeholderTextColor="rgba(255,255,255,0.35)"
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            accessibilityLabel={t ? t('live.sendMessage') : 'Send a message'}
          />
        </View>
        <TouchableOpacity
          onPress={handleSend}
          style={[styles.sendBtn, inputText.trim() ? styles.sendBtnActive : null]}
          activeOpacity={0.7}
          accessibilityLabel={t ? t('feed.send') : 'Send'}
          accessibilityRole="button"
          disabled={!inputText.trim()}
        >
          <IconSend size={16} color={inputText.trim() ? '#fff' : 'rgba(255,255,255,0.4)'} />
        </TouchableOpacity>
      </View>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 320,
  },
  gradientTop: {
    height: 20,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to bottom, rgba(0,0,0,0.3), transparent)',
    } : {}),
  },
  listWrapper: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 6,
    paddingTop: 4,
  },
  systemMsg: {
    paddingVertical: 4,
    alignItems: 'center',
  },
  systemPill: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
  },
  systemText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontStyle: 'italic',
    letterSpacing: 0.2,
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
    gap: 8,
  },
  msgBubble: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    borderTopLeftRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  msgName: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginBottom: 1,
  },
  msgText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  inputContainer: {
    flex: 1,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  input: {
    height: 40,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 14,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: {
    backgroundColor: ACCENT,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 8px rgba(37,211,102,0.4)',
    } : {}),
  },
});
