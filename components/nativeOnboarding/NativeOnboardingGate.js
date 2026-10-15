// [2026-10-15 native-onboarding] Porta do fluxo novo: crash de render dentro
// dele → desliga o fluxo novo pelo resto da sessão e mostra o `fallback`
// (fluxo legado), sem tela branca.
import React from 'react';
import NativeOnboardingFlow from './NativeOnboardingFlow';
import { disableNativeOnboardingForSession } from './flag';

export default class NativeOnboardingGate extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    try { disableNativeOnboardingForSession(`render: ${String(err?.message || err).slice(0, 200)}`); } catch {}
  }

  render() {
    if (this.state.failed) {
      const fb = this.props.fallback;
      return typeof fb === 'function' ? fb() : (fb || null);
    }
    const { fallback, ...rest } = this.props; // eslint-disable-line no-unused-vars
    return <NativeOnboardingFlow {...rest} />;
  }
}
