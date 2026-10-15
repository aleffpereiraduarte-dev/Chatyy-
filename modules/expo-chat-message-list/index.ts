// modules/expo-chat-message-list — [2026-10-14 native-list]
//
// Lista de MENSAGENS da conversa nativa (view `ChatyyMessageList`).
//   iOS: UICollectionView invertida, células desenhadas com CoreText (layout
//        numa fila de fundo, altura cacheada), imagem com cache próprio
//        (mesma pasta do expo-media-viewer), arrastar-p/-responder nativo.
//   Android: RecyclerView invertida (reverseLayout), StaticLayout pré-calculado
//        num executor, Glide p/ imagens.
// O wrapper React (diff incremental, fallback, flags) mora em
// components/chat/nativeThreadList.js. Binário sem o módulo → isAvailable()
// false e a conversa usa a FlashList JS.
import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeMod = { apiVersion(): number };

let _mod: NativeMod | null | undefined;

export function isAvailable(): boolean {
  if (_mod === undefined) {
    try { _mod = requireOptionalNativeModule<NativeMod>('ChatyyMessageList'); } catch { _mod = null; }
  }
  try { return !!_mod && _mod.apiVersion() >= 1; } catch { return false; }
}
