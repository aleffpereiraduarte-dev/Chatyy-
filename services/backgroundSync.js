/**
 * Background Sync Service
 * Keeps email and chat synced even when app is in background
 * Uses expo-background-fetch + expo-task-manager
 */
import { Platform } from 'react-native';

const BACKGROUND_FETCH_TASK = 'ONEMUNDO_BACKGROUND_SYNC';

// defineTask MUST run at module top-level — Expo's headless executor reloads
// the JS bundle and only finds tasks registered synchronously at startup.
// If we do it inside register(), the OS may invoke the task before the user
// app has called register() and we'd hit "Task not defined".
if (Platform.OS !== 'web') {
  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');
    TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
      try {
        const api = require('./api');
        const token = api.getAuthToken();
        if (!token) return BackgroundFetch.BackgroundFetchResult.NoData;
        const result = await api.chatUnreadCount();
        return (result && result.success)
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.NoData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
  } catch {}
}

export async function registerBackgroundSync() {
  if (Platform.OS === 'web') return;
  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');
    const status = await BackgroundFetch.getStatusAsync();
    if (status !== BackgroundFetch.BackgroundFetchStatus.Available) {
      console.warn('[BackgroundSync] Status not Available:', status);
      return;
    }
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (already) return;
    await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    console.log('[BackgroundSync] Registered successfully');
  } catch (e) {
    console.warn('[BackgroundSync] Registration failed:', e);
  }
}

export async function unregisterBackgroundSync() {
  if (Platform.OS === 'web') return;

  try {
    const BackgroundFetch = require('expo-background-fetch');
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
  } catch {}
}
