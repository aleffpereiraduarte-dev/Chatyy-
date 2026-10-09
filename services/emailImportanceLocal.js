// [2026-10-09 on-device-privacy] Importância do e-mail calculada NO APARELHO.
//
// Antes: cada e-mail novo da caixa ia (remetente + assunto + 500 chars do
// corpo) para `email_classify_importance` → LLM na nuvem (713/dia, ~0,93 s,
// 36% > 1 s). Agora é uma heurística local, síncrona, sem rede, com a mesma
// saída: 'high' | 'normal' | 'low'. A mesma regra roda no servidor
// (api/ai-categorize.php → _importanceHeuristic) para clientes antigos.
//
// Sinais: remetente automático/lista (noreply, newsletter, List-Unsubscribe,
// Precedence: bulk), categoria do servidor (promoções/social/atualizações),
// palavras de promo vs. urgência/prazo/segurança/financeiro, resposta de
// thread (Re:), remetente com quem você já trocou e-mail (respondido antes),
// remetente frequente e contatos conhecidos.

const AUTOMATED_RE = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|promo(?:tions?)?|offers?|deals|campaigns?|mailing|digest|updates?|info|hello|team|support|billing|automated?)([._+-]|@)/i;
const BULK_DOMAIN_RE = /@(?:[^@\s>]*\.)?(?:mailchimp|mcsv|mcdlv|sendgrid|amazonses|mailgun|sendinblue|brevo|hubspot|hs-?email|constantcontact|klaviyo|mktomail|exacttarget|rsgsv|e\.|em\.|email\.|mail\.|news\.|info\.|marketing\.)/i;
const PERSONAL_DOMAIN_RE = /@(?:gmail|googlemail|outlook|hotmail|live|msn|icloud|me|mac|yahoo|ymail|uol|bol|terra|ig|proton(?:mail)?|pm|gmx|zoho|chatyy|onemundo)\./i;

const PROMO_WORDS = [
  'unsubscribe', 'descadastr', 'cancelar inscri', 'newsletter', 'webinar', 'weekly digest', 'resumo semanal',
  '% off', 'desconto', 'discount', 'oferta', 'special offer', 'promoção', 'promocao', 'cupom', 'coupon', 'frete gr', 'free shipping',
  'black friday', 'cyber monday', 'liquidação', 'liquidacao', 'on sale', 'big sale', 'compre agora', 'buy now', 'shop now', 'aproveite',
  'não perca', 'nao perca', "don't miss", 'últimas unidades', 'ultimas unidades', 'imperdível', 'imperdivel',
];
const URGENT_WORDS = [
  'urgente', 'urgent', 'asap', 'importante', 'important', 'prazo', 'deadline', 'vence hoje', 'vencimento',
  'ação necessária', 'acao necessaria', 'action required', 'atenção', 'atencao', 'aprovação', 'aprovacao',
  'approval', 'contrato', 'contract', 'assinatura', 'signature', 'reunião', 'reuniao', 'meeting',
  'entrevista', 'interview', 'proposta', 'proposal', 'orçamento', 'orcamento', 'quote',
];
const SECURITY_WORDS = [
  'alerta de segurança', 'alerta de seguranca', 'security alert', 'novo login', 'new sign-in', 'new login',
  'senha alterada', 'password changed', 'password reset', 'redefinir senha', 'atividade suspeita',
  'suspicious activity', 'conta bloqueada', 'account locked', 'account suspended', 'conta suspensa',
];
const MONEY_WORDS = [
  'fatura vencida', 'pagamento recusado', 'payment failed', 'payment declined', 'overdue', 'em atraso',
  'atrasad', 'cobrança', 'cobranca', 'boleto vence', 'intimação', 'intimacao', 'judicial', 'processo n',
  'receita federal', 'multa', 'chargeback', 'reembolso negado',
];
const REPLY_RE = /^\s*(re|res|resp|aw|sv|vs|rif|antw)\s*:/i;

function _has(text, words) {
  for (let i = 0; i < words.length; i++) if (text.indexOf(words[i]) !== -1) return true;
  return false;
}

// "Fulano <a@b.com>" | "a@b.com" → "a@b.com" (minúsculo).
export function senderAddress(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  const m2 = addr.match(/[^\s<>"']+@[^\s<>"']+/);
  return m2 ? m2[0] : addr;
}

// Contexto local derivado da própria lista (sem rede): remetentes a quem você
// já respondeu (flag \Answered) e quantos e-mails cada um mandou.
export function buildImportanceContext(emails, extra) {
  const replied = new Set();
  const freq = new Map();
  if (Array.isArray(emails)) {
    for (const e of emails) {
      if (!e) continue;
      const a = senderAddress(e.from);
      if (!a) continue;
      freq.set(a, (freq.get(a) || 0) + 1);
      if (e.answered || (Array.isArray(e.flags) && e.flags.includes('\\Answered'))) replied.add(a);
    }
  }
  const contacts = extra && extra.contacts instanceof Set ? extra.contacts : null;
  return { replied, freq, contacts };
}

// e = { from, from_name?, subject, snippet|preview|body_preview, category?,
//       answered?, list_unsubscribe?, precedence?, headers? }
export function classifyImportanceLocal(e, ctx) {
  if (!e) return 'normal';
  const addr = senderAddress(e.from);
  const subject = String(e.subject || '').toLowerCase();
  const body = String(e.snippet || e.preview || e.body_preview || '').slice(0, 500).toLowerCase();
  const text = subject + '\n' + body;
  const headers = String(e.headers || '').toLowerCase();
  const isList = !!e.list_unsubscribe || /^list-unsubscribe:/m.test(headers)
    || /^precedence:\s*(bulk|list|junk)/m.test(headers) || /^(bulk|list|junk)$/i.test(String(e.precedence || ''));
  const automated = AUTOMATED_RE.test(addr) || BULK_DOMAIN_RE.test(addr);
  const human = !!addr && !automated && !isList;

  let score = 0;
  if (automated) score -= 3;
  if (isList) score -= 4;
  const cat = String(e.category || '').toLowerCase();
  if (cat === 'promotions') score -= 3;
  else if (cat === 'social') score -= 2;
  else if (cat === 'updates') score -= 1;
  if (_has(text, PROMO_WORDS)) score -= 2;

  if (_has(text, URGENT_WORDS)) score += human ? 3 : 1;
  // Alerta de segurança / dinheiro vem de remetente automático → pesa mais
  // para compensar o desconto de "automático".
  if (_has(text, SECURITY_WORDS)) score += automated ? 8 : 4;
  if (_has(text, MONEY_WORDS)) score += automated ? 7 : 4;
  if (human && REPLY_RE.test(subject)) score += 2;
  if (human && PERSONAL_DOMAIN_RE.test(addr)) score += 1;

  if (ctx && addr) {
    if (ctx.replied && ctx.replied.has(addr)) score += 3;
    if (ctx.contacts && ctx.contacts.has(addr)) score += 2;
    if (human && ctx.freq && (ctx.freq.get(addr) || 0) >= 3) score += 1;
  }
  if (e.answered) score += 1;

  if (score >= 3) return 'high';
  if (score <= -3) return 'low';
  return 'normal';
}

export default classifyImportanceLocal;
