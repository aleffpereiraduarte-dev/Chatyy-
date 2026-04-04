import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Appearance } from 'react-native';
import { IconAlertTriangle } from './Icons';
import { Sentry } from '../services/sentry';

function getColors() {
  const scheme = Appearance?.getColorScheme?.() || 'light';
  if (scheme === 'dark') {
    return {
      bg: '#111827',
      text: '#f1f5f9',
      sub: '#94a3b8',
      error: '#f87171',
      btnBg: '#2563eb',
      btnText: '#fff',
    };
  }
  return {
    bg: '#f8fafc',
    text: '#0f172a',
    sub: '#64748b',
    error: '#dc2626',
    btnBg: '#2563eb',
    btnText: '#fff',
  };
}

export default class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary]', error?.message, error?.stack, errorInfo?.componentStack);
    this.setState({ componentStack: errorInfo?.componentStack || '' });
    // Report to Sentry
    try { Sentry.captureException(error); } catch {}
    // Send crash report to server
    try {
      fetch('https://chatyy.com.br/api/email.php?action=crash_report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: error?.message || 'Erro desconhecido',
          stack: (error?.stack || '').substring(0, 3000),
          component: (errorInfo?.componentStack || '').substring(0, 2000),
          fatal: true,
        }),
      }).catch(() => {});
    } catch {}
  }

  render() {
    if (this.state.hasError) {
      const c = getColors();
      return (
        <View style={[s.container, { backgroundColor: c.bg }]}>
          <IconAlertTriangle size={48} color={c.error} style={{ marginBottom: 16 }} />
          <Text style={[s.title, { color: c.text }]}>Something went wrong</Text>
          <Text style={[s.message, { color: c.sub }]}>Copie o erro e envie pro suporte:</Text>
          {this.state.error?.message && (
            <Text selectable style={{ color: c.error, fontSize: 12, marginTop: 8, textAlign: 'left', paddingHorizontal: 20, fontFamily: 'monospace' }}>
              {this.state.error.message}
            </Text>
          )}
          {this.state.error?.stack && (
            <Text selectable style={{ color: c.sub, fontSize: 9, marginTop: 4, textAlign: 'left', paddingHorizontal: 20, fontFamily: 'monospace' }} numberOfLines={10}>
              {this.state.error.stack.substring(0, 500)}
            </Text>
          )}
          <TouchableOpacity
            style={[s.button, { backgroundColor: c.btnBg }]}
            onPress={() => this.setState({ hasError: false, error: null, componentStack: '' })}
          >
            <Text style={[s.buttonText, { color: c.btnText }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  message: { fontSize: 14, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  debug: { fontSize: 11, textAlign: 'center', marginBottom: 16, fontFamily: 'monospace' },
  button: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24 },
  buttonText: { fontSize: 14, fontWeight: '700' },
});
