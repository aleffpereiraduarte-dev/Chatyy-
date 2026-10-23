// [F-Q0 quic-noise 2026-10-23] Simulação do núcleo de services/netQuality.js (NetQCore).
// node puro:  node tests/netQuality/sim.mjs   (saída != 0 = falhou)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../../services/netQuality.js'), 'utf8');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nq-')), 'netQuality.mjs');
fs.writeFileSync(tmp, src);
const Q = await import(pathToFileURL(tmp).href);

let fails = 0, n = 0;
const eq = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FALHA') + ' ' + name + (ok ? '' : `  → ${JSON.stringify(got)} (esperado ${JSON.stringify(want)})`));
};
let T = 1_800_000_000_000;
const mk = (ctx = { reg: 'br', tr: 'native', net: 'wifi' }) => new Q.NetQCore({ now: () => T, ctx: () => ctx });
const rowsOf = (c, e) => c.rows.filter((r) => r.e === e);

// 1. troca wifi→celular, socket half-open morre 8 s depois (pong) → janela começa NA troca, causa net/w2c
{
  const c = mk(); c.boot(true);
  T += 1000; c.netChange('w2c');
  T += 8000; c.drop('pong_deadline', 0);
  T += 2000; c.send(T - 1500, T + 500, 'text'); // tocou durante a janela, ✓ depois
  T += 1000; c.authed({ nrm: 3000 });
  T += 500; c.send(T - 4000, T, 'text');         // tocou antes do authed, ✓ agora (janela fechada, atrasado)
  T += 100000; c.tick(false);
  const g = rowsOf(c, 'gap')[0];
  eq('w2c: causa', [g.c, g.nk, g.end], ['net', 'w2c', 'up']);
  eq('w2c: ms desde a troca', g.ms, 11000);
  eq('w2c: envios afetados', [g.ns, g.wmax], [2, 4000]);
  const ne = rowsOf(c, 'net')[0];
  eq('w2c: socket NÃO sobreviveu', [ne.k, ne.surv, ne.dms], ['w2c', 0, 8000]);
  eq('w2c: nrm do nativo', g.nrm, 3000);
}
// 2. troca de rede e socket sobrevive 20 s
{
  const c = mk(); c.boot(true);
  c.netChange('c2w'); T += 21000; c.tick(false);
  eq('c2w sobreviveu', rowsOf(c, 'net').map((r) => [r.k, r.surv]), [['c2w', 1]]);
  eq('sem janela', rowsOf(c, 'gap').length, 0);
}
// 3. 2º plano: nativo pausa (drop em bg ignorado), volta com socket morto → janela bg a partir da volta
{
  const c = mk(); c.boot(true);
  T += 1000; c.background();
  c.drop('native_paused:bg', 0);
  T += 60000; c.foreground(false);
  T += 1200; c.authed({});
  c.tick(true);
  const g = rowsOf(c, 'gap')[0];
  eq('bg: causa/ms', [g.c, g.d, g.ms], ['bg', 'lost_in_bg', 1200]);
}
// 4. volta ao 1º plano com socket "vivo" que a sonda mata em 2 s → bg desde a volta
{
  const c = mk(); c.boot(true);
  c.background(); T += 30000; c.foreground(true);
  T += 2000; c.drop('probe_dead_foreground', 0);
  T += 800; c.authed({}); c.tick(true);
  const g = rowsOf(c, 'gap')[0];
  eq('fg zumbi: causa/ms', [g.c, g.ms], ['bg', 2800]);
}
// 5. close 1006 sem troca de rede; janela cortada pelo 2º plano
{
  const c = mk(); c.boot(true);
  T += 60000; c.drop('', 1006);
  T += 3000; c.background(); c.tick(true);
  const g = rowsOf(c, 'gap')[0];
  eq('1006 cortado: causa/end/ms', [g.c, g.d, g.end, g.ms], ['close', '1006_', 'bg', 3000]);
}
// 6. boot + handshake + resumo
{
  const c = mk({ reg: 'scl', tr: 'js', net: 'c4g', rtt: 40 }); c.boot(false);
  T += 900; c.hs({ ms: 850, connectMs: 600, authMs: 250, transport: 'js' }); c.authed({});
  T += 50; c.send(T - 10, T, 'text'); // tocou depois de autenticar → não afetado
  T += 10000; c.summary(); c.tick(true);
  eq('boot gap', rowsOf(c, 'gap').map((r) => [r.c, r.ms, r.ns]), [['boot', 900, 0]]);
  eq('hs', rowsOf(c, 'hs').map((r) => [r.ms, r.cn, r.au, r.rtt, r.reg]), [[850, 600, 250, 40, 'scl']]);
  const s = rowsOf(c, 'sum')[0];
  eq('sum', [s.sends, s.aff, s.gaps, s.gapms], [1, 0, 1, 900]);
}
// 7. classificação
eq('netChangeKind', [
  Q.netChangeKind({ isConnected: true, type: 'wifi' }, { isConnected: true, type: 'cellular' }),
  Q.netChangeKind({ isConnected: true, type: 'wifi', ssid: 'a' }, { isConnected: true, type: 'wifi', ssid: 'b' }),
  Q.netChangeKind({ isConnected: true, type: 'cellular', ipAddress: '1' }, { isConnected: true, type: 'cellular', ipAddress: '2' }),
  Q.netChangeKind({ isConnected: true, type: 'wifi' }, { isConnected: false, type: 'none' }),
  Q.netChangeKind({ isConnected: true, type: 'unknown' }, { isConnected: true, type: 'wifi' }),
  Q.netChangeKind({ isConnected: true, type: 'wifi' }, { isConnected: true, type: 'wifi' }),
], ['w2c', 'ssid', 'ip', 'down', null, null]);
eq('causeOf', [Q.causeOf('pong_deadline'), Q.causeOf('', 1006), Q.causeOf('session_replaced', 4002), Q.causeOf('native_reconnecting:net_change'), Q.causeOf('', 1001)],
  ['ping', 'close', 'replaced', 'net', 'srv']);
// 8. sem conteúdo: nenhuma chave fora do esquema
{
  const allowed = new Set(['e','c','d','nk','ms','end','fg','off','reg','reg2','tr','tr2','net0','net1','att','ns','nm','npre','wmax','w','nrm','k','up','surv','dms','net','cn','au','rtt','pr','dns','tcp','tls','ru','fgs','sends','aff','gaps','gapms','netdrop']);
  const c = mk(); c.boot(false); c.authed({}); c.netChange('w2c'); T += 1000; c.drop('pong', 0); c.hs({ ms: 1, connectMs: 1, authMs: 0 }); c.authed({}); c.summary(); c.tick(true);
  const bad = c.rows.flatMap((r) => Object.keys(r).filter((k) => !allowed.has(k)));
  eq('esquema fechado', bad, []);
}
console.log(`\n${n - fails}/${n} ok`);
process.exit(fails ? 1 : 0);
