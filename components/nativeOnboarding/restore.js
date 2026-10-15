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

export async function probeRestore(accountEmail) {
  const email = String(accountEmail || '').toLowerCase().trim();
  // 1. backup próprio (E2E) no servidor
  try {
    const ob = require('../../services/ownBackup');
    const cand = await _timeout(ob.findRestoreCandidate(email), 6000);
    if (cand) return { kind: 'own', candidate: cand };
  } catch {}
  if (Platform.OS === 'web') return null;

  // 2. CYB2 / iCloud / Drive
  try {
    const skipped = await AsyncStorage.getItem('@chatyy_skip_restore');
    if (skipped !== '1') {
      let mmkv = null;
      let asked = false;
      try {
        const { MMKV } = require('react-native-mmkv');
        mmkv = new MMKV({ id: 'chatyy-backup' });
        if (email && mmkv.getString(`restore_prompted:${email}`) === '1') asked = true;
      } catch {}
      let convs = null;
      if (!asked) {
        try {
          const dbMod = require('../../services/db');
          if (typeof dbMod.dbGetConversations === 'function') convs = await dbMod.dbGetConversations(true);
        } catch {}
      }
      if (!asked && !(Array.isArray(convs) && convs.length > 0)) {
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
        if (merged.length) {
          try { if (mmkv && email) mmkv.set(`restore_prompted:${email}`, '1'); } catch {}
          return { kind: 'legacy', backups: merged };
        }
      }
    }
  } catch {}

  // 3. histórico completo do servidor
  try {
    if ((await AsyncStorage.getItem('@chatyy_skip_history')) !== '1' && email) {
      const api = require('../../services/api');
      const { isBootstrapNeeded } = require('../../services/fullHistorySync');
      if (await _timeout(isBootstrapNeeded(api.apiCall, email), 6000)) return { kind: 'history', email };
    }
  } catch {}
  return null;
}
