// [phone-obrigatorio 2026-10-15] "Adicione seu número" p/ contas antigas sem telefone verificado.
// Regra do founder: 1 conta = 1 número (como WhatsApp). Cadastro novo já exige número no servidor;
// contas antigas continuam funcionando e recebem este pedido.
//
// FASE 1 (agora): dá p/ pular ("Agora não") e o app pergunta de novo a cada PHONE_LINK_SNOOZE_DAYS.
// FASE 2: PHONE_LINK_REQUIRED = true (ou CHATYY_PHONE_LINK_REQUIRED=1 no servidor → status.required)
//          some o "Agora não" e o pedido vira obrigatório.
//
// Servidor (email.php): phone_link_status · phone_link_precheck · phone_link. O código em si usa o
// MESMO caminho do cadastro (verify_send / verify_check) → mesmos limites, trava de 5 erros e anti-abuso.
// Contas QA / revisão das lojas / serviço / Kids são isentas NO SERVIDOR (exempt=true).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

export const PHONE_LINK_REQUIRED = false;
export const PHONE_LINK_SNOOZE_DAYS = 7;

const KEY = 'chatyy_phone_link_v1:';
const DAY = 24 * 60 * 60 * 1000;

async function _read(email) {
  try {
    const raw = await AsyncStorage.getItem(KEY + String(email || '').toLowerCase());
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
async function _write(email, patch) {
  try {
    const cur = await _read(email);
    await AsyncStorage.setItem(KEY + String(email || '').toLowerCase(), JSON.stringify({ ...cur, ...patch }));
  } catch {}
}

// → { show:boolean, required:boolean }. Nunca lança. Só consulta o servidor quando o pedido estaria
// vencido (conta já com número / isenta fica gravada e não pergunta mais).
export async function shouldAskPhoneLink(email) {
  const no = { show: false, required: false };
  if (!email) return no;
  try {
    const st = await _read(email);
    if (st.done || st.exempt) return no;
    const now = Date.now();
    if (!PHONE_LINK_REQUIRED && st.snoozeUntil && now < st.snoozeUntil) return no;
    const r = await api.phoneLinkStatus();
    if (!r?.success || !r.data) return no; // offline / servidor antigo → tenta na próxima abertura
    const d = r.data;
    if (d.has_phone) { await _write(email, { done: true }); return no; }
    if (d.exempt) { await _write(email, { exempt: true }); return no; }
    const required = PHONE_LINK_REQUIRED || !!d.required;
    if (!required && st.snoozeUntil && now < st.snoozeUntil) return no;
    return { show: !!d.prompt || required, required, snoozeDays: Number(d.snooze_days) || PHONE_LINK_SNOOZE_DAYS };
  } catch { return no; }
}

export async function snoozePhoneLink(email, days = PHONE_LINK_SNOOZE_DAYS) {
  await _write(email, { snoozeUntil: Date.now() + Math.max(1, Number(days) || PHONE_LINK_SNOOZE_DAYS) * DAY });
}

export async function markPhoneLinked(email) {
  await _write(email, { done: true, snoozeUntil: 0 });
}
