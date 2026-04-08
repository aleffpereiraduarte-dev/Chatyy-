import { NativeModule, requireNativeModule } from 'expo';

export type CachedMessage = {
  id: number;
  conversation_id: number;
  sender_email?: string;
  content?: string;
  type?: string;
  file_url?: string;
  file_name?: string;
  file_size?: number;
  created_at?: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  reply_to_id?: number | null;
  reactions?: Array<{ emoji: string; count: number; users?: string[] }>;
};

export type CachedConversation = {
  id: number;
  type?: string;             // 'direct' | 'group'
  name?: string;
  avatar_url?: string;
  last_message?: string;
  last_sender?: string;
  last_timestamp?: string;
  unread_count?: number;
  members?: string[];
  pinned?: boolean;
  muted?: boolean;
};

declare class ExpoChatCacheModuleClass extends NativeModule {
  // ─── Messages (per conversation) ─────────────────────────────────
  /** Synchronous fetch of last N messages for a conversation. Safe in useState init. */
  getCachedMessagesSync(conversationId: number, limit?: number): CachedMessage[];
  /** Synchronous fetch of the last sync id (max id in cache) for incremental fetch. */
  getLastSyncIdSync(conversationId: number): number;
  /** Insert / replace a single message. */
  saveMessage(conversationId: number, message: CachedMessage): Promise<void>;
  /** Bulk insert / replace messages. */
  saveMessages(conversationId: number, messages: CachedMessage[]): Promise<void>;
  /** Pre-warm the in-memory cache for a conversation. */
  warmCache(conversationId: number): Promise<void>;
  /** Clear the cache for one conversation. */
  clearConversation(conversationId: number): Promise<void>;
  /** Wipe everything (e.g. on logout). */
  clearAll(): Promise<void>;

  // ─── Conversation list (chat tab) ────────────────────────────────
  /** Synchronous fetch of all cached conversations, sorted by last_timestamp DESC. */
  getCachedConversationsSync(): CachedConversation[];
  /** Bulk replace the conversation list cache (full snapshot from server). */
  saveConversations(conversations: CachedConversation[]): Promise<void>;
  /** Update a single conversation (e.g. when a new message arrives). */
  updateConversation(conversation: CachedConversation): Promise<void>;
  /** Clear all cached conversations (logout). */
  clearConversations(): Promise<void>;

  // ─── Media URI cache (remote URL → local file path) ──────────────
  /**
   * Synchronous lookup: given a remote URL, return the local file path
   * if it's already downloaded — otherwise return null. Used in render to
   * pick file:// when available, fall back to remote URL otherwise.
   */
  getLocalUriSync(remoteUrl: string): string | null;
  /**
   * Schedule a background download of a remote media URL. The file is
   * stored in Caches/chat-media/<sha256>. When done, getLocalUriSync will
   * return its path. Idempotent — safe to call repeatedly.
   */
  prefetchMedia(remoteUrl: string): Promise<void>;
  /** Mark a media file as downloaded (called after JS-side download). */
  registerLocalMedia(remoteUrl: string, localPath: string): Promise<void>;
  /** Total cache size in bytes — for showing storage usage. */
  getMediaCacheSize(): Promise<number>;
  /** Clear all cached media files. */
  clearMediaCache(): Promise<void>;

  // ─── Email cache (inbox + folders) ───────────────────────────────
  getCachedEmailsSync(folder: string, limit?: number): any[];
  saveEmails(folder: string, emails: any[]): Promise<void>;
  clearFolder(folder: string): Promise<void>;

  // ─── Drive/files cache ───────────────────────────────────────────
  getCachedDriveFilesSync(parentId: number, limit?: number): any[];
  saveDriveFiles(parentId: number, files: any[]): Promise<void>;

  // ─── Avatar cache (per email address) ────────────────────────────
  getAvatarLocalUriSync(email: string): string | null;
  prefetchAvatar(email: string, remoteUrl: string): Promise<void>;
}

export default requireNativeModule<ExpoChatCacheModuleClass>('ExpoChatCacheModule');
