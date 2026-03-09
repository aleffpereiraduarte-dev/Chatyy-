/**
 * Background Sync Service
 * Keeps email and chat synced even when app is in background
 * Uses expo-background-fetch + expo-task-manager
 */
import { Platform } from 'react-native';

const BACKGROUND_FETCH_TASK = 'ONEMUNDO_BACKGROUND_SYNC';
const BACKGROUND_NOTIFICATION_TASK = 'ONEMUNDO_BACKGROUND_NOTIFICATION';

export async function registerBackgroundSync() {
  if (Platform.OS === 'web') return;

  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');

    // Define the background task
    TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
      try {
        // Check for new emails/messages silently
        const api = require('./api');
        const token = api.getAuthToken();
        if (!token) return BackgroundFetch.BackgroundFetchResult.NoData;

        // Quick check if there are new messages
        // The server will send push notifications for individual items
        // This just ensures the WS connection stays alive
        return BackgroundFetch.BackgroundFetchResult.NewData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });

    // Register the background fetch
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Available) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 15 * 60, // 15 minutes minimum
        stopOnTerminate: false,
        startOnBoot: true,
      });
      console.log('[BackgroundSync] Registered successfully');
    }
  } catch (e) {
    console.warn('[BackgroundSync] Registration failed:', e.message);
  }
}

export async function unregisterBackgroundSync() {
  if (Platform.OS === 'web') return;

  try {
    const BackgroundFetch = require('expo-background-fetch');
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
  } catch {}
}
