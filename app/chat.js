import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconPlus, IconMessageSquare, IconPhone, IconUser,
} from '../components/Icons';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import ChatListTab from '../components/ChatListTab';
import ChatCallsTab from '../components/ChatCallsTab';
import ChatStatusTab from '../components/ChatStatusTab';
import ChatProfileTab from '../components/ChatProfileTab';

// Status icon (circle with dashed border)
function IconStatus({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <SvgCircle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" fill="none" strokeDasharray="4 3" />
      <SvgCircle cx="12" cy="12" r="4" fill={color} />
    </Svg>
  );
}

class ChatErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ChatScreenWrapper() {
  return (
    <ChatErrorBoundary>
      <ChatHub />
    </ChatErrorBoundary>
  );
}

function ChatHub() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState('chats');

  const tabProps = { colors, isDark, t, user, router };

  // Tab titles
  const titles = {
    status: 'Status',
    calls: t('chat.tabCalls') || 'Ligações',
    chats: 'Chats',
    config: t('chat.tabConfig') || 'Configurações',
  };

  // Header right action based on tab
  const renderHeaderAction = () => {
    if (activeTab === 'chats') {
      return (
        <TouchableOpacity onPress={() => router.push('/chat-new')} style={styles.headerIconBtn}>
          <IconPlus size={22} color={colors.text} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'calls') {
      return (
        <TouchableOpacity onPress={() => router.push('/chat-new')} style={styles.headerIconBtn}>
          <IconPhone size={20} color={colors.text} />
        </TouchableOpacity>
      );
    }
    return null;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>{titles[activeTab]}</Text>
        <View style={styles.headerActions}>
          {renderHeaderAction()}
        </View>
      </View>

      {/* Tab content */}
      <View style={{ flex: 1 }}>
        {activeTab === 'chats' && <ChatListTab {...tabProps} />}
        {activeTab === 'calls' && <ChatCallsTab {...tabProps} />}
        {activeTab === 'status' && <ChatStatusTab {...tabProps} />}
        {activeTab === 'config' && <ChatProfileTab {...tabProps} />}
      </View>

      {/* Bottom tab bar — WhatsApp style */}
      <View style={[styles.tabBar, {
        backgroundColor: colors.background,
        borderTopColor: colors.border,
        paddingBottom: insets.bottom || 8,
      }]}>
        <TabBarItem
          icon={<IconStatus size={24} color={activeTab === 'status' ? '#25D366' : colors.textTertiary} />}
          label="Status"
          active={activeTab === 'status'}
          onPress={() => setActiveTab('status')}
          colors={colors}
        />
        <TabBarItem
          icon={<IconPhone size={24} color={activeTab === 'calls' ? '#25D366' : colors.textTertiary} />}
          label={t('chat.tabCalls') || 'Ligações'}
          active={activeTab === 'calls'}
          onPress={() => setActiveTab('calls')}
          colors={colors}
        />
        <TabBarItem
          icon={<IconMessageSquare size={24} color={activeTab === 'chats' ? '#25D366' : colors.textTertiary} />}
          label="Chats"
          active={activeTab === 'chats'}
          onPress={() => setActiveTab('chats')}
          colors={colors}
        />
        <TabBarItem
          icon={<IconUser size={24} color={activeTab === 'config' ? '#25D366' : colors.textTertiary} />}
          label={t('chat.tabConfig') || 'Config'}
          active={activeTab === 'config'}
          onPress={() => setActiveTab('config')}
          colors={colors}
        />
      </View>
    </View>
  );
}

function TabBarItem({ icon, label, active, onPress, colors }) {
  return (
    <TouchableOpacity style={styles.tabItem} onPress={onPress} activeOpacity={0.7}>
      {icon}
      <Text style={[styles.tabLabel, { color: active ? '#25D366' : colors.textTertiary }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  backBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    flex: 1,
    letterSpacing: -0.5,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerIconBtn: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    gap: 2,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
});
