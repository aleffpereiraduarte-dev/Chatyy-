/**
 * /advanced-privacy — rota antiga, mantida para links/atalhos.
 *
 * [2026-10-21 privacidade-unica] "Privacidade" e "Privacidade avançada" viraram
 * UMA página (components/settings/categories/PrivacyCategory.js: cartão hero da
 * Privacidade avançada no topo + todas as opções de Privacidade, proxy/Tor,
 * captura no app, encontrar pelo número). Esta rota só redireciona para ela:
 * /settings-section?section=privacy (substitui no histórico, voltar = tela de antes).
 */
import { Redirect } from 'expo-router';

export default function AdvancedPrivacyRedirect() {
  return <Redirect href={{ pathname: '/settings-section', params: { section: 'privacy' } }} />;
}
