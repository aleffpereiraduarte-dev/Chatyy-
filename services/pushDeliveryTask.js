/**
 * [2026-10-08 receipts-speed] ✓✓ cinza com o app em 2º PLANO via push (JS).
 *
 * Por que existe: o "entregue" no push (device-ack) só existia no NATIVO
 * (iOS NSE NotificationService.swift / Android ChatDeliveryReporter.kt), ou seja,
 * só em binários novos (iOS ≥ 646 / Android ≥ 592). Quem está num binário
 * antigo (ex.: iOS 624, runtime 2.5.0) e põe o app em 2º plano NUNCA marcava
 * entregue: o socket morre na suspensão e o ✓ do remetente só virava ✓✓ quando
 * a pessoa reabria o app (conv 952, 2026-10-08 00:27Z — 3 msgs sem recibo).
 *
 * Como: expo-notifications `registerTaskAsync` roda esta task quando o push
 * CHEGA com o app em 2º plano (iOS: exige `content-available:1` — o servidor
 * manda `_contentAvailable` nos pushes de chat; Android: todo push Expo com o
 * app em 2º plano). A task acha o token assinado `d_ack` (HMAC, escopo
 * msg+conversa+destinatário, firebase_push.php) e faz POST em
 * email.php?action=chat_push_delivered — o MESMO endpoint do NSE/FCM nativo.
 * Sem bearer, sem SQLite, sem socket: só um fetch. Servidor é idempotente
 * (NSE + task + WS no mesmo id = 1 recibo; repetidos = skipped).
 *
 * Só funciona via OTA em binários que já têm expo-task-manager +
 * remote-notification em UIBackgroundModes (todos os builds 2.5.0/2.6.0).
 * App morto pelo usuário (force-quit iOS / Android terminado) não acorda JS —
 * esse caso continua sendo do NSE/ChatDeliveryReporter nativos.
 *
 * Kill-switch OTA: globalThis.__chatyy_push_dack_task = false.
 */
import { Platform, AppState } from 'react-native';

export const PUSH_DACK_TASK = 'CHATYY_PUSH_DELIVERY_ACK_v1';
const ACK_URL = 'https://chatyy.com.br/api/email.php?action=chat_push_delivered';
const _seen = new Set();
const CHAT_TYPES = new Set(['chat_message', 'chat_mention', 'chat_keyword']);

// O payload muda por plataforma/caminho (APNs: data.body = JSON string do
// `data` do Expo; FCM: data.body/dataString; às vezes já objeto). Busca rasa
// e limitada por `d_ack`, parseando strings JSON no caminho.
function _findDack(node, depth = 0) {
  if (node == null || depth > 5) return null;
  if (typeof node === 'string') {
    const s = node.trim();
    if (s.length > 2 && s.length < 16384 && (s[0] === '{' || s[0] === '[') && s.includes('d_ack')) {
      try { return _findDack(JSON.parse(s), depth + 1); } catch { return null; }
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (typeof node.d_ack === 'string' && node.d_ack.includes('.')) {
    const t = String(node.type || '');
    if (!t || CHAT_TYPES.has(t)) return node.d_ack;
  }
  for (const k of Object.keys(node)) {
    if (k === 'd_ack') continue;
    const r = _findDack(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}

export async function ackPushDelivered(payload) {
  const tok = _findDack(payload);
  if (!tok || _seen.has(tok)) return false;
  _seen.add(tok);
  if (_seen.size > 300) { const first = _seen.values().next().value; _seen.delete(first); }
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, 8000) : null;
    const r = await fetch(ACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ d_ack: tok }),
      signal: ctl ? ctl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    return !!(r && r.ok);
  } catch {
    _seen.delete(tok); // deixa um re-push / próxima wake tentar de novo
    return false;
  }
}

if (Platform.OS !== 'web') {
  try {
    const TaskManager = require('expo-task-manager');
    const Notifications = require('expo-notifications');
    if (globalThis.__chatyy_push_dack_task !== false && TaskManager?.defineTask) {
      // defineTask no TOP-LEVEL: o executor headless recarrega o bundle e só
      // acha tasks registradas sincronamente no startup.
      TaskManager.defineTask(PUSH_DACK_TASK, async ({ data, error }) => {
        const NoData = Notifications?.BackgroundNotificationTaskResult?.NoData ?? 1;
        const NewData = Notifications?.BackgroundNotificationTaskResult?.NewData ?? 0;
        if (error || !data) return NoData;
        // Toque numa ação (Android) não é "chegou" — ignora.
        if (data && typeof data === 'object' && 'actionIdentifier' in data) return NoData;
        // Em 1º plano o socket/handler de foreground já acka (WS delivery_ack).
        try { if (AppState.currentState === 'active') return NoData; } catch {}
        const ok = await ackPushDelivered(data);
        return ok ? NewData : NoData;
      });
      Notifications?.registerTaskAsync?.(PUSH_DACK_TASK)?.catch?.(() => {});
    }
  } catch {}
}
