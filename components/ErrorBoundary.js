import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Appearance } from 'react-native';
import { IconAlertTriangle } from './Icons';

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
  }

  render() {
    if (this.state.hasError) {
      const c = getColors();
      const errMsg = this.state.error?.message || 'Unknown error';
      const errStack = this.state.error?.stack || '';
      const compStack = this.state.componentStack || '';
      // Extract first 3 lines of stack for debug
      const shortStack = errStack.split('\n').slice(0, 4).join('\n');
      const shortComp = compStack.split('\n').slice(0, 5).join('\n');
      return (
        <View style={[s.container, { backgroundColor: c.bg }]}>
          <IconAlertTriangle size={48} color={c.error} style={{ marginBottom: 16 }} />
          <Text style={[s.title, { color: c.text }]}>Something went wrong</Text>
          <Text style={[s.message, { color: c.sub }]}>An unexpected error occurred. Please try again.</Text>
          <Text style={[s.debug, { color: c.error }]}>{errMsg}</Text>
          {shortStack ? <Text style={[s.debug, { color: c.sub, marginTop: 8 }]}>{shortStack}</Text> : null}
          {shortComp ? <Text style={[s.debug, { color: c.sub, marginTop: 4 }]}>{shortComp}</Text> : null}
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
