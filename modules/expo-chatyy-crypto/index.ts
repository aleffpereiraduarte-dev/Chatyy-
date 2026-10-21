// [e2ee5 WP-03] Ponte JS crua do módulo nativo "ChatyyCrypto" (iOS/Android).
//
// NÃO use direto no app: a API normativa (CONTRATO §6.11) é services/crypto (index.native.js
// embrulha esta ponte; index.web.js é o host wasm do WP-04).
//
// O módulo só conta como presente se:
//   - existe no binário (requireOptionalNativeModule; build sem ele → null, sem crash);
//   - info().apiVersion >= REQUIRED_API_VERSION;
//   - info().coreLinked === true (o binário foi gerado com o núcleo — input chatyy_crypto do CI).
import { requireOptionalNativeModule } from 'expo-modules-core';

/** Menor versão da API nativa que este JS entende (sobe junto com mudanças incompatíveis). */
export const REQUIRED_API_VERSION = 1;

export type NativeInfo = {
  apiVersion: number;
  coreLinked: boolean;
  platform: 'ios' | 'android';
  process: string;
};

export type NativeEventName =
  | 'onSyncResult'
  | 'onNewKeys'
  | 'onIdentityChanged'
  | 'onIdentityViolation'
  | 'onNativeFlag';

type Subscription = { remove: () => void };

type ChatyyCryptoNative = {
  info(): NativeInfo;
  nativeEnabled(uid: string): boolean;
  invoke(op: string, argsJson: string): Promise<string>;
  addListener(name: NativeEventName, cb: (body: any) => void): Subscription;
};

let _mod: ChatyyCryptoNative | null | undefined;
let _info: NativeInfo | null = null;

/** Módulo nativo utilizável, ou null (ausente, versão velha ou stub sem núcleo). */
export function getNative(): ChatyyCryptoNative | null {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    const m = requireOptionalNativeModule('ChatyyCrypto') as ChatyyCryptoNative | null;
    if (m && typeof m.info === 'function') {
      const info = m.info();
      _info = info || null;
      if (info && Number(info.apiVersion) >= REQUIRED_API_VERSION && info.coreLinked === true) _mod = m;
    }
  } catch (_) {
    _mod = null;
  }
  return _mod;
}

/** `info()` do binário (também no stub), ou null se o módulo não existe. */
export function nativeInfo(): NativeInfo | null {
  getNative();
  return _info;
}

export function isNativeAvailable(): boolean {
  return getNative() !== null;
}
