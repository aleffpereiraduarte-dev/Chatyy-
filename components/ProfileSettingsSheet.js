/**
 * ProfileSettingsSheet — [2026-10-11 settings-unify] agora é só um ATALHO.
 *
 * Antes era um 2º app de Configurações inteiro (Instagram-style, ~3100
 * linhas) que duplicava /settings: privacidade, notificações, armazenamento,
 * idioma, aparência, e-mail, IA, aparelhos, exportação, Chatyy One… Cada
 * ajuste novo precisava ser feito em 2–3 lugares e os dois saíam de
 * sincronia (ex.: download automático gravava em modelos diferentes).
 *
 * Agora existe UM hub: app/settings.js (+ components/settings/*). Este
 * componente mantém a mesma assinatura para quem ainda o monta, mas, ao
 * abrir, apenas navega para o hub (opcionalmente numa seção) e fecha.
 * A implementação antiga está arquivada em ProfileSettingsSheet.js.legacy.
 */
import { useEffect } from 'react';

export default function ProfileSettingsSheet({ visible, onClose, router, section }) {
  useEffect(() => {
    if (!visible) return;
    try {
      const r = router || require('expo-router').router;
      r?.push?.(section ? `/settings?section=${encodeURIComponent(section)}` : '/settings');
    } catch {}
    // Close on the next tick so the push lands before the parent re-renders.
    const id = setTimeout(() => { try { onClose?.(); } catch {} }, 0);
    return () => clearTimeout(id);
  }, [visible]);
  return null;
}
