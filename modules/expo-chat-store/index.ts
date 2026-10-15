// [2026-10-15 native-store] Store local NATIVO (SQLite do sistema, 1 arquivo por conta).
// Fase 1: "fotos" por conversa (as linhas já montadas que a lista nativa
// mostrou) — a lista nativa (modules/expo-chat-message-list, prop `store`) lê e
// grava direto, sem passar pelo JS. Este objeto JS só serve p/ gate, limpeza
// (logout/troca de conta) e diagnóstico. Ver docs/native-store-DESIGN.md.
import { requireOptionalNativeModule } from 'expo';

export type ChatStoreStats = { threads: number; rows: number; bytes: number; messages?: number; convs?: number; homeRows?: number };
export type ChatStoreBatchResult = { ok: number; why?: string; messages?: number; threads?: number; convs?: number };

type ChatyyChatStoreNative = {
  apiVersion(): number;
  /** Chave da mensagem mais nova da foto salva da conversa ('' = sem foto). */
  threadNewestSync(account: string, conv: string): string;
  statsSync(account: string): ChatStoreStats;
  // ── apiVersion ≥ 2 (fase 1.5/2) ──
  /** Lote do sync: 1 string JSON (formato: docs/native-store-DESIGN.md §3.3). */
  applyBatchAsync?(account: string, json: string): Promise<ChatStoreBatchResult>;
  /** pressIn da home: foto decodificada em memória (a lista pinta síncrona). */
  prewarmThread?(account: string, conv: string): void;
  /** "rev\ntop" da foto da home ('' = sem foto). */
  homeTopSync?(account: string, scope: string): string;
  /** Mensagens canônicas "[raw,…]" antiga→nova (beforeId 0 = mais novas). */
  messagesSync?(account: string, conv: string, beforeId: number, limit: number): string;
  wipeAccount(account: string): Promise<void>;
  wipeAll(): Promise<void>;
};

const mod = requireOptionalNativeModule<ChatyyChatStoreNative>('ChatyyChatStore');
export default mod;
