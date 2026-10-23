// [lb-sticky 2026-10-23] Simulação das regras sticky do client-lb (services/clientLb.js `decide`).
// Sem jest no projeto: node puro. Roda:  node tests/clientLb/sticky-sim.mjs   (saída != 0 = falhou)
// Carrega o clientLb.js REAL trocando só o import do react-native por um stub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../../services/clientLb.js'), 'utf8')
  .replace("import { Platform } from 'react-native';", "const Platform = { OS: 'ios' };");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clb-')), 'clientLb.mjs');
fs.writeFileSync(tmp, src);
const L = await import(pathToFileURL(tmp).href);

// Lista com todas as regiões ativas (o fallback embutido tem scl/mex desligadas).
const list = { ...L.getList(), regions: L.BUILTIN_REGIONS.map((r) => ({ ...r, active: true, health: r.id === 'us' ? 'up' : 'unknown' })) };
let fails = 0, n = 0;
const eq = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FALHA') + ' ' + name + (ok ? '' : `  → ${JSON.stringify(got)} (esperado ${JSON.stringify(want)})`));
};
const T0 = 1_800_000_000_000;
// Sequência de medições espaçadas, carregando pending/sessão como o api.js faz.
function run(seq, { current, sticky, busyAt = [], oneShotAt = [], session } = {}) {
  let cur = current, pending = null;
  const s = session || { voluntary: 0, lastSwitchAt: 0 };
  const out = [];
  seq.forEach((results, i) => {
    const d = L.decide({ results, current: cur, pending, session: s, list, now: T0 + i * 45000, sticky, busy: busyAt.includes(i), oneShot: oneShotAt.includes(i) });
    pending = d.pending;
    if (d.kind === 'switch') { s.voluntary++; s.lastSwitchAt = T0 + i * 45000; }
    cur = d.pick;
    out.push(d.kind + ':' + d.pick + ':' + d.why);
  });
  return out;
}

// 1) Santiago Wi-Fi: scl 16, br 67 → fica.
eq('scl bom fica', run([{ scl: 16, br: 67, us: 250 }], { current: 'scl' }), ['keep:scl:best']);
// 2) Android 03:27Z: /health scl 16 × br 80 (pong do WS scl 397 não entra) → fica, 3× seguidas.
eq('pong do WS não derruba scl', run([{ scl: 16, br: 80, us: 285 }, { scl: 16, br: 80, us: 285 }, { scl: 16, br: 80, us: 285 }], { current: 'scl' }),
  ['keep:scl:best', 'keep:scl:best', 'keep:scl:best']);
//    regra antiga (kill) com o placar misturado (0,7×16 + 0,3×397 = 130) trocava na 2ª medição:
eq('regra antiga trocava (kill)', run([{ scl: 130, br: 80, us: 285 }, { scl: 130, br: 80, us: 285 }], { current: 'scl', sticky: false }),
  ['pending:scl:confirm_1/2', 'switch:br:faster_50ms']);
// 3) Celular em roaming (T-Mobile): scl 383 × mex 267 → 383 ≤ 1,5×267 = 400 → fica no scl (antes: mex).
eq('roaming: scl 383 × mex 267 fica', run([{ scl: 383, mex: 267, mia: 266, usw: 267, us: 367 }], { current: 'scl', oneShotAt: [0] }), ['keep:scl:sticky']);
// 4) Atual ruim de verdade (300 × br 60): troca só na 3ª medição espaçada.
const bad = { scl: 300, br: 60, us: 250 };
eq('vantagem grande sustentada troca na 3ª', run([bad, bad, bad], { current: 'scl' }),
  ['pending:scl:confirm_1/3', 'pending:scl:confirm_2/3', 'switch:br:faster_240ms']);
// 5) Pico isolado: 1 medição ruim e volta → zera, não troca.
eq('pico isolado não troca', run([bad, { scl: 18, br: 66, us: 250 }, bad, bad], { current: 'scl' }),
  ['pending:scl:confirm_1/3', 'keep:scl:best', 'pending:scl:confirm_1/3', 'pending:scl:confirm_2/3']);
// 6) Envio pendente/ligação: adia (não conta, não perde), troca depois que liberar.
eq('busy adia', run([bad, bad, bad, bad], { current: 'scl', busyAt: [1, 2] }),
  ['pending:scl:confirm_1/3', 'keep:scl:busy', 'keep:scl:busy', 'pending:scl:confirm_2/3']);
// 7) Troca de rede (1 reavaliação): 1 medição basta se a vantagem for grande.
eq('rede nova reavalia 1×', run([bad], { current: 'scl', oneShotAt: [0] }), ['switch:br:net_240ms']);
eq('rede nova + busy não troca', run([bad], { current: 'scl', oneShotAt: [0], busyAt: [0] }), ['keep:scl:busy']);
// 8) Falha real: atual mudo → failover imediato (mesmo busy).
eq('atual mudo = failover', run([{ scl: null, br: 70, us: 250 }], { current: 'scl', busyAt: [0] }), ['failover:br:current_no_reply']);
// 9) Piso de 80 ms: atual 70 × melhor 10 → fica.
eq('piso 80 ms', run([{ br: 70, scl: 10, us: 200 }], { current: 'br' }), ['keep:br:sticky']);
// 10) Fora do sticky mas margem pequena (100 × 65: 35 %) → fica.
eq('margem < 40 % fica', run([{ scl: 100, br: 65, us: 200 }], { current: 'scl' }), ['keep:scl:hysteresis']);
// 11) Bem no limite: 90 × 50 (44 %, 40 ms) troca só após 3; 90 × 55 (35 ms) nunca.
eq('90 × 50 (40 ms, 44 %) precisa de 3', run([{ scl: 90, br: 50 }, { scl: 90, br: 50 }, { scl: 90, br: 50 }], { current: 'scl' }),
  ['pending:scl:confirm_1/3', 'pending:scl:confirm_2/3', 'switch:br:faster_40ms']);
eq('90 × 55 (35 ms) fica', run([{ scl: 90, br: 55 }], { current: 'scl' }), ['keep:scl:hysteresis']);
// 12) Limite por sessão: 2 trocas voluntárias já feitas → fixa.
eq('máx. por sessão', run([bad, bad, bad], { current: 'scl', session: { voluntary: 2, lastSwitchAt: 0 } }),
  ['pending:scl:confirm_1/3', 'pending:scl:confirm_2/3', 'keep:scl:pinned_max']);
// 13) 1ª escolha sem atual: palpite (memória/geo) fica se for "bom".
n++; { const d = L.decide({ results: { scl: 30, br: 12, us: 200 }, current: null, list, base: 'scl', sticky: true }); const ok = d.pick === 'scl' && d.why === 'first_base'; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FALHA') + ' 1ª escolha fica no palpite bom → ' + d.pick); }
// 14) Pulo da memória da rede (api.js usa stickyWouldSwitch nas RTTs lembradas):
eq('memória celular mex 233 × scl 367 não pula', L.stickyWouldSwitch(233, 367), false);
eq('memória br 60 × scl 300 pula', L.stickyWouldSwitch(60, 300), true);
eq('memória sem RTT do atual = mede antes', L.stickyWouldSwitch(60, undefined), true);
// 15) Kill a quente.
globalThis.__chatyy_lb_sticky = false;
eq('kill → stickyOn false', L.stickyOn(), false);
eq('kill → regra antiga (2 medições, 25 %/30 ms)', run([bad, bad], { current: 'scl' }), ['pending:scl:confirm_1/2', 'switch:br:faster_240ms']);
delete globalThis.__chatyy_lb_sticky;
eq('sem flag → stickyOn true', L.stickyOn(), true);

console.log(`\n${n - fails}/${n} ok`);
process.exit(fails ? 1 : 0);
