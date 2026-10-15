// modules/expo-chat-transport — [2026-10-15 native-transport]
//
// Transporte realtime NATIVO (WebSocket com o hub Go :8084 / edges regionais).
// O JS continua dono da lógica de negócio (services/websocket.js); este módulo
// só é o "fio": conecta, reautentica sozinho, pinga, detecta zumbi, reconecta
// na troca de rede / volta do background, guarda frames enquanto cai e entrega
// os frames recebidos em LOTE ao JS. O shim WebSocket-compatível mora em
// services/nativeTransport.js. Binário sem o módulo → null → WebSocket JS.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type TransportState =
  | 'connecting' | 'open' | 'authed' | 'reconnecting' | 'offline' | 'paused' | 'auth_wait' | 'closed' | 'failed';

let _mod: any;
export function getChatTransport(): any | null {
  if (_mod === undefined) {
    try { _mod = requireOptionalNativeModule('ChatyyTransport'); } catch { _mod = null; }
  }
  return _mod || null;
}
