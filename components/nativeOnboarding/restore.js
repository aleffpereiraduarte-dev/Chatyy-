// [2026-10-15 native-onboarding] Depois de entrar/criar conta: há algo para
// restaurar? Mesmos portões e mesma ordem do /login (maybePromptRestoreThenGo):
//   1. backup E2E no servidor do Chatyy (services/ownBackup) — também na web
//   2. backup CYB2 no servidor / iCloud / Drive (RestoreBackupPrompt) — nativo
//   3. baixar o histórico completo do servidor (RestoreHistoryPrompt) — nativo
// Nunca bloqueia: qualquer falha → null (segue para o app).
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

function _timeout(p, ms) {
  return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
}

// [2026-10-16 onb-opening] As 3 sondagens rodavam EM SÉRIE (6 s + 6 s + 8 s + 6 s
// no pior caso = até ~26 s olhando "Abrindo seu Chatyy…"). Agora rodam em
// PARALELO e a prioridade (1 → 2 → 3) é aplicada no resultado; o único efeito
// colateral (marcar "já perguntei" do backup legado) só acontece se ele for o
// escolhido. Pior caso ≈ 14 s (iCloud), típico = 1 ida e volta.
export async function probeRestore(accountEmail) {
  const email = String(accountEmail || '').toLowerCase().trim();
  // 1. backup próprio (E2E) no servidor
  const ownP = (async () => {
    try {
      const ob = require('../../services/ownBackup');
      return (await _timeout(ob.findRestoreCandidate(email), 6000)) || null;
    } catch { return null; }
  })();
  if (Platform.OS === 'web') {
    const cand = await ownP;
    return cand ? { kind: 'own', candidate: cand } : null;
  }

  // 2. CYB2 / iCloud / Drive
  const legacyP = (async () => {
    try {
      const skipped = await AsyncStorage.getItem('@chatyy_skip_restore');
      if (skipped === '1') return null;
      let mmkv = null;
      try {
        const { MMKV } = require('react-native-mmkv');
        mmkv = new MMKV({ id: 'chatyy-backup' });
        if (email && mmkv.getString(`restore_prompted:${email}`) === '1') return null;
      } catch {}
      let convs = null;
      try {
        const dbMod = require('../../services/db');
        if (typeof dbMod.dbGetConversations === 'function') convs = await dbMod.dbGetConversations(true);
      } catch {}
      if (Array.isArray(convs) && convs.length > 0) return null;
      let serverBackups = [];
      try {
        const api = require('../../services/api');
        const resp = await _timeout(api.chatBackupList(), 6000);
        const list = resp?.backups || resp?.data?.backups || [];
        serverBackups = Array.isArray(list) ? list : [];
      } catch {}
      let cloudBackups = [];
      if (!serverBackups.length) {
        try {
          const ChatBackup = require('expo-chat-backup');
          cloudBackups = (await _timeout(ChatBackup.listBackups(), 8000)) || [];
        } catch { cloudBackups = []; }
      }
      const merged = serverBackups.length
        ? serverBackups.map((b) => ({ source: 'server', id: b.id, filename: `backup-${b.id}.enc`, createdAt: b.created_at, size: b.size_bytes || 0 }))
        : (Array.isArray(cloudBackups) ? cloudBackups.map((b) => ({ source: 'cloud', ...b })) : []);
      if (!merged.length) return null;
      return { backups: merged, mark: () => { try { if (mmkv && email) mmkv.set(`restore_prompted:${email}`, '1'); } catch {} } };
    } catch { return null; }
  })();

  // 3. histórico completo do servidor
  const histP = (async () => {
    try {
      // [2026-10-18 bg-sync] histórico do servidor baixa sozinho em 2º plano → sem modal.
      if (globalThis.__chatyy_bg_history !== false) return false;
      if ((await AsyncStorage.getItem('@chatyy_skip_history')) === '1' || !email) return false;
      const api = require('../../services/api');
      const { isBootstrapNeeded } = require('../../services/fullHistorySync');
      return !!(await _timeout(isBootstrapNeeded(api.apiCall, email), 6000));
    } catch { return false; }
  })();

  const cand = await ownP;
  if (cand) return { kind: 'own', candidate: cand };
  const leg = await legacyP;
  if (leg) { leg.mark(); return { kind: 'legacy', backups: leg.backups }; }
  if (await histP) return { kind: 'history', email };
  return null;
}
