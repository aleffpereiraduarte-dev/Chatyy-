import { requireNativeModule } from 'expo';

interface DonateRecipientArgs {
  /** Conversation ID — used as INPerson customIdentifier so the share
   *  extension can route a tapped suggestion back to the right thread. */
  conversationId: string;
  /** Display name shown in the Share Sheet row. */
  name: string;
  /** Email or phone — used as INPersonHandle.value. */
  email: string;
  /** Optional file path or http(s) URL for the avatar shown next to name. */
  avatarUri?: string;
}

interface ShareExtensionConversation {
  id: string | number;
  name: string;
  email: string;
  avatarUrl?: string;
  type?: 'direct' | 'group';
  lastMessageAt?: string;
}

declare class IntentsClass {
  /** Donate one INSendMessageIntent so this contact appears in iOS Share Sheet
   *  suggestions. Call after a successful send. Resolves true on success. */
  donateRecipient(args: DonateRecipientArgs): Promise<boolean>;
  /** Wipe ALL Chatyy intent donations (privacy / logout). */
  deleteAllDonations(): Promise<boolean>;
  /** Delete donations for a single conversation (e.g. after the user
   *  deletes a conversation). */
  deleteByGroup(groupId: string): Promise<boolean>;
  /** Push the bearer token + base URL into the App Group so the native
   *  ShareExtension UI can post to the Chatyy API on the user's behalf. */
  setShareExtensionAuth(token: string, email: string, baseUrl: string): boolean;
  /** Push a snapshot of recent conversations (top 30) into the App Group
   *  so the native ShareExtension can render its contact list. */
  setShareExtensionConversations(conversations: ShareExtensionConversation[]): boolean;
  /** Wipe all share-extension cached data (call on logout). */
  clearShareExtensionData(): boolean;
  /** WAVE 87 (2026-05-21): read the ShareExtension diagnostic ring buffer.
   *  Each entry: { ts: number (unix sec), level: 'info'|'warn'|'error', msg: string }. */
  getShareExtensionDiag(): Array<{ ts: number; level: string; msg: string }>;
  /** WAVE 87 (2026-05-21): read the last error entry only (faster than the full buffer). */
  getShareExtensionLastError(): { ts: number; level: string; msg: string } | null;
  /** WAVE 87 (2026-05-21): clear the diagnostic ring buffer + last-error. */
  clearShareExtensionDiag(): boolean;
}

let _mod: IntentsClass | null = null;
function getMod(): IntentsClass | null {
  if (_mod !== null) return _mod;
  try { _mod = requireNativeModule<IntentsClass>('ExpoChatyyIntents'); }
  catch { _mod = null as any; }
  return _mod;
}

/** Safe no-op on Android / web / older binaries. Never throws. */
export const Intents = {
  donateRecipient: async (args: DonateRecipientArgs): Promise<boolean> => {
    try { return (await getMod()?.donateRecipient(args)) ?? false; }
    catch { return false; }
  },
  deleteAllDonations: async (): Promise<boolean> => {
    try { return (await getMod()?.deleteAllDonations()) ?? false; }
    catch { return false; }
  },
  deleteByGroup: async (groupId: string): Promise<boolean> => {
    try { return (await getMod()?.deleteByGroup(groupId)) ?? false; }
    catch { return false; }
  },
  setShareExtensionAuth: (token: string, email: string, baseUrl: string): boolean => {
    try { return getMod()?.setShareExtensionAuth(token, email, baseUrl) ?? false; }
    catch { return false; }
  },
  setShareExtensionConversations: (conversations: ShareExtensionConversation[]): boolean => {
    try { return getMod()?.setShareExtensionConversations(conversations) ?? false; }
    catch { return false; }
  },
  clearShareExtensionData: (): boolean => {
    try { return getMod()?.clearShareExtensionData() ?? false; }
    catch { return false; }
  },
  getShareExtensionDiag: (): Array<{ ts: number; level: string; msg: string }> => {
    try { return getMod()?.getShareExtensionDiag() ?? []; }
    catch { return []; }
  },
  getShareExtensionLastError: (): { ts: number; level: string; msg: string } | null => {
    try { return getMod()?.getShareExtensionLastError() ?? null; }
    catch { return null; }
  },
  clearShareExtensionDiag: (): boolean => {
    try { return getMod()?.clearShareExtensionDiag() ?? false; }
    catch { return false; }
  },
};

export default Intents;
