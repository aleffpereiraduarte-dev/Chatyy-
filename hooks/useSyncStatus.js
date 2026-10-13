// [2026-10-13 sync-status] Hook do estado EXIBÍVEL de sincronização da home
// ({ kind: 'idle'|'connecting'|'offline'|'updating'|'bootstrap', progress }).
// Toda a política (debounce, watchdog, 2º plano) mora em services/syncStatus.js.
import { useSyncExternalStore } from 'react';
import { subscribeSyncStatus, getSyncStatus } from '../services/syncStatus';

export default function useSyncStatus() {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}

// Rótulo i18n de um estado (null quando idle).
export function syncStatusLabel(st, t) {
  const tr = (k, fb, p) => {
    try { const v = t ? t(k, p) : ''; if (v && v !== k) return v; } catch {}
    return fb;
  };
  switch (st && st.kind) {
    case 'offline': return tr('syncStatus.waitingNetwork', 'Aguardando rede');
    case 'connecting': return tr('syncStatus.connecting', 'Conectando…');
    case 'updating': return tr('syncStatus.updating', 'Atualizando…');
    case 'bootstrap': {
      if (typeof st.progress === 'number') {
        const pct = String(st.progress);
        return tr('syncStatus.downloadingPct', `Baixando conversas ${pct}%`, { pct }).replace('{pct}', pct);
      }
      return tr('syncStatus.downloading', 'Baixando conversas…');
    }
    default: return null;
  }
}
