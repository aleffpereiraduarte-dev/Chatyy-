/**
 * Background Sync Service — Offline Queue Replay
 *
 * Tenta reenviar a fila offline (chat_send, send_email, media uploads, etc.)
 * mesmo com o app em background ou fechado. WhatsApp faz isso via iOS
 * Background Task / Android WorkManager — sem isso o usuário precisa abrir
 * o app pra um replay acontecer e mensagens pendentes ficam paradas até lá.
 *
 * Task: `CHATYY_OFFLINE_REPLAY_v1`
 * Frequência: mínima 15min (cap do iOS — Android também usa o mesmo valor
 * via WorkManager.PeriodicWorkRequest).
 *
 * Estratégia:
 *  - Pula sem trabalho se a fila estiver vazia (NoData).
 *  - Chama `replayOfflineQueue(api)` quando há ações pendentes.
 *  - Mapeia o retorno pra `NewData` / `NoData` / `Failed` pra o OS ajustar
 *    o budget de execução do app em background.
 *
 * TODO(wire): registrar em `app/_layout.js` no mount inicial (após login)
 * com `await registerBackgroundSync()`. Não fizemos aqui porque _layout.js
 * está em rota crítica de outro patch — chamada explícita posterior.
 */
import { Platform } from 'react-native';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';

export const TASK_NAME = 'CHATYY_OFFLINE_REPLAY_v1';

// defineTask precisa rodar no top-level do módulo: o executor headless do
// Expo recarrega o bundle JS e só acha tasks registradas sincronamente no
// startup. Se fizer dentro de register() o OS pode invocar a task antes do
// user app ter chamado register() e cai em "Task not defined".
if (Platform.OS !== 'web') {
  try {
    TaskManager.defineTask(TASK_NAME, async () => {
      try {
        const offlineCache = require('./offlineCache');
        // api.js usa named exports (sem default) — require do módulo
        // inteiro entrega o namespace que replayOfflineQueue espera
        // (chama api.chatUploadFile, api.deleteEmail, etc.).
        const api = require('./api');

        // Skip cedo se a fila estiver vazia — não queima budget de
        // background pra nada. getOfflineQueueSize pode não existir em
        // builds antigas; fallback pra getOfflineQueue().length.
        let size = 0;
        if (typeof offlineCache.getOfflineQueueSize === 'function') {
          size = await offlineCache.getOfflineQueueSize();
        } else if (typeof offlineCache.getOfflineQueue === 'function') {
          const q = await offlineCache.getOfflineQueue();
          size = Array.isArray(q) ? q.length : 0;
        }

        // [2026-10-04] Também drena o OUTBOX V2 (SQLite messageOutbox). No
        // nativo os envios de texto do chat passam pelo messageOutbox/sendWorker
        // (não pela fila legacy do offlineCache), então sem isto uma mensagem
        // digitada offline com o app fechado NUNCA saía em background — só
        // quando o app voltava ao foreground. Conta as linhas pendentes do V2
        // pra decidir NoData vs NewData e pra não queimar budget à toa.
        let v2Pending = 0;
        let outbox = null;
        let sendWorker = null;
        try { outbox = require('./messageOutbox'); } catch {}
        try { sendWorker = require('./sendWorker').default || require('./sendWorker'); } catch {}
        try {
          if (outbox) {
            // Reabilita linhas presas em 'sending' de uma execução anterior
            // interrompida (o processo background pode ter sido morto no meio).
            await outbox.recoverStuck?.();
            const pending = await (outbox.getAllPending?.() || outbox.getPending?.(null));
            v2Pending = Array.isArray(pending) ? pending.length : 0;
          }
        } catch {}

        if ((!size || size === 0) && v2Pending === 0) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }

        let legacyReplayed = 0;
        if (size > 0) {
          const result = await offlineCache.replayOfflineQueue(api);
          // replayOfflineQueue retorna { replayed, failed } — aceita
          // também `completed` (alias defensivo) caso a API evolua.
          legacyReplayed = (result?.replayed || result?.completed || 0);
        }

        // Drena o V2 e espera a passada completar (poke() retorna a Promise do
        // drain). Fire-and-forget seria inútil num executor headless que encerra
        // logo após o return.
        if (v2Pending > 0 && sendWorker?.poke) {
          try { await sendWorker.poke(); } catch {}
          // [2026-10-07 send-media] media upload lane: start due uploads and give
          // them the remaining background budget (bounded — iOS kills the task
          // around 30s; whatever is unfinished resumes from the persisted
          // chunk session next time).
          try {
            const ups = await outbox.getPending?.(null, { lane: 'upload' });
            if (Array.isArray(ups) && ups.length > 0) {
              const mq = require('./mediaSendQueue');
              await (mq.kick || mq.default?.kick)?.();
              await new Promise((res) => setTimeout(res, 20000));
              await sendWorker.poke();
            }
          } catch {}
        }

        const ok = legacyReplayed > 0 || v2Pending > 0;
        return ok
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.NoData;
      } catch (e) {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
  } catch {
    // defineTask pode lançar se o bundle for recarregado e a task já
    // estiver definida — silencioso, é idempotente.
  }
}

export async function registerBackgroundSync() {
  if (Platform.OS === 'web') return false;
  try {
    const status = await BackgroundFetch.getStatusAsync();
    // Restricted = parental controls / MDM bloqueando background refresh.
    // Denied = usuário desligou em Settings. Ambos = não vale tentar.
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      return false;
    }
    const already = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (already) return true;
    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      minimumInterval: 15 * 60, // 15min — mínimo do iOS
      stopOnTerminate: false,   // Android: sobreviver app kill
      startOnBoot: true,        // Android: re-armar após reboot
    });
    return true;
  } catch {
    return false;
  }
}

export async function unregisterBackgroundSync() {
  if (Platform.OS === 'web') return false;
  try {
    const already = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (!already) return true;
    await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
    return true;
  } catch {
    return false;
  }
}

export async function isBackgroundSyncRegistered() {
  if (Platform.OS === 'web') return false;
  try {
    return await TaskManager.isTaskRegisteredAsync(TASK_NAME);
  } catch {
    return false;
  }
}
