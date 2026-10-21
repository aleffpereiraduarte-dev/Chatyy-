// [e2ee5 WP-15 2026-10-21] Aviso "isto sai da criptografia" antes de mandar conteúdo de uma
// conversa E2EE para um serviço do servidor, SÓ por ação explícita do usuário (DECISÃO 2):
//   kind: 'translate' · 'bia' · 'transcribe' · 'summary' · 'report' (denúncia com evidência)
// confirmExitEncryption(t, kind, { always }) → Promise<boolean>
//   - mostra na 1ª vez por tipo (lembra em AsyncStorage `e2ee5_exit_ack_<kind>`); `always:true`
//     mostra sempre (ex.: denúncia).
//   - flag desligada (isE2eeUiEnabled() false) → resolve true sem mostrar nada (o caminho de hoje).
// Quem chama (WP-17) decide se a conversa é E2EE; este helper só pergunta.
import { Alert, Platform } from 'react-native';
import { isE2eeUiEnabled, tx } from './e2eeUi';

let AsyncStorage = null;
try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}

const TEXTS = {
  translate: ['e2ee5.exit.translate', 'Para traduzir, o texto desta mensagem sai da criptografia de ponta a ponta e é enviado ao serviço de tradução. Ele não fica salvo no Chatyy.'],
  bia: ['e2ee5.exit.bia', 'A Bia só lê o trecho que você escolher. Esse trecho sai da criptografia de ponta a ponta para a Bia poder responder, e não fica salvo no Chatyy.'],
  transcribe: ['e2ee5.exit.transcribe', 'Para transcrever, este áudio sai da criptografia de ponta a ponta e é enviado ao serviço de transcrição. Ele não fica salvo no Chatyy.'],
  summary: ['e2ee5.exit.summary', 'Para resumir, as mensagens escolhidas saem da criptografia de ponta a ponta e são enviadas ao serviço de resumo. Elas não ficam salvas no Chatyy.'],
  report: ['e2ee5.exit.report', 'Ao denunciar, as últimas mensagens desta conversa são enviadas ao Chatyy para análise. As outras pessoas não são avisadas.'],
};

export function exitEncryptionText(t, kind) {
  const e = TEXTS[kind] || TEXTS.translate;
  return tx(t, e[0], e[1]);
}

export async function confirmExitEncryption(t, kind, opts = {}) {
  if (!isE2eeUiEnabled()) return true;
  const key = `e2ee5_exit_ack_${kind}`;
  if (!opts.always && AsyncStorage) {
    try { if ((await AsyncStorage.getItem(key)) === '1') return true; } catch {}
  }
  const title = tx(t, 'e2ee5.exit.title', 'Isto sai da criptografia');
  const msg = exitEncryptionText(t, kind);
  const ok = await new Promise((resolve) => {
    if (Platform.OS === 'web') {
      let r = false;
      try { r = window.confirm(`${title}\n\n${msg}`); } catch {}
      resolve(!!r);
      return;
    }
    Alert.alert(title, msg, [
      { text: tx(t, 'e2ee5.common.cancel', 'Cancelar'), style: 'cancel', onPress: () => resolve(false) },
      { text: tx(t, 'e2ee5.exit.continue', 'Continuar'), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
  if (ok && !opts.always && AsyncStorage) { try { await AsyncStorage.setItem(key, '1'); } catch {} }
  return ok;
}
