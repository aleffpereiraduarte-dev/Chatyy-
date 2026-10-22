// scripts/fly/build-preview.js — [voar 2026-10-22] gera a prévia jogável preview-2026/voar.html com o MESMO
// motor/desenho/laço do app (services/flyGame/{engine,renderer,loop}.js embutidos, sem cópia à mão).
// uso: node scripts/fly/build-preview.js [/var/www/mail/preview-2026/voar.html]
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../../services/flyGame');
const mod = (n) => `__def(${JSON.stringify('./' + n)}, function (module, exports, require) {\n${fs.readFileSync(path.join(dir, n + '.js'), 'utf8')}\n});`;
const out = process.argv[2] || '/var/www/mail/preview-2026/voar.html';

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>Brisa · prévia</title>
<meta name="description" content="Prévia jogável do Brisa, o jogo de voar com um toque do Chatyy (mesmo motor do app).">
<style>
:root { --bg:#0E1117; --card:#1A1F28; --text:#EEF3F8; --muted:#9AA6B6; --accent:#8FD3FF; --line:rgba(255,255,255,.08); }
:root[data-theme="light"] { --bg:#ECEFF3; --card:#FFFFFF; --text:#14181F; --muted:#5B6574; --line:rgba(0,0,0,.08); }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg:#ECEFF3; --card:#FFFFFF; --text:#14181F; --muted:#5B6574; --line:rgba(0,0,0,.08); } }
* { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { min-height:100%; display:flex; gap:28px; align-items:center; justify-content:center; padding:24px 16px; flex-wrap:wrap; }
.phone { position:relative; width:min(390px, 100%); aspect-ratio: 390/800; max-height: calc(100dvh - 48px); border-radius:38px; overflow:hidden; background:#141A24; box-shadow:0 30px 80px rgba(0,0,0,.45), 0 0 0 1px var(--line); touch-action:none; user-select:none; -webkit-user-select:none; }
@media (max-width: 520px) { .wrap { padding:0; } .phone { width:100%; height:100dvh; max-height:none; aspect-ratio:auto; border-radius:0; } .notes { display:none; } }
canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.hud { position:absolute; inset:0; pointer-events:none; display:flex; flex-direction:column; align-items:center; }
.score { margin-top: calc(env(safe-area-inset-top) + 54px); font-size:64px; font-weight:800; color:#fff; letter-spacing:-1px; text-shadow:0 4px 18px rgba(0,0,0,.35); font-variant-numeric: tabular-nums; }
.top { position:absolute; top: calc(env(safe-area-inset-top) + 14px); left:14px; right:14px; display:flex; justify-content:space-between; pointer-events:auto; }
.chip { height:34px; min-width:34px; padding:0 12px; border-radius:17px; background:rgba(20,26,36,.55); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color:#EAF2FA; display:flex; align-items:center; gap:6px; font-size:13px; font-weight:700; border:1px solid rgba(255,255,255,.08); cursor:pointer; }
.chip svg { width:16px; height:16px; }
.ready { position:absolute; left:0; right:0; top:56%; display:flex; flex-direction:column; align-items:center; gap:10px; color:#fff; text-align:center; }
.ready h1 { margin:0; font-size:44px; letter-spacing:-1px; font-weight:800; }
.ready p { margin:0; color:#CFE0EE; font-size:15px; font-weight:600; }
.pill { display:inline-flex; align-items:center; gap:8px; padding:9px 16px; border-radius:22px; background:rgba(143,211,255,.16); color:#BFE6FF; font-weight:700; font-size:14px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { transform: scale(1.05); background:rgba(143,211,255,.26);} }
@media (prefers-reduced-motion: reduce) { .pill { animation:none; } }
.over { position:absolute; left:18px; right:18px; bottom: calc(env(safe-area-inset-bottom) + 26px); background:rgba(18,23,32,.86); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border:1px solid rgba(255,255,255,.08); border-radius:28px; padding:20px 18px 18px; color:#EEF3F8; pointer-events:auto; transform: translateY(16px); opacity:0; transition: .22s ease; }
.over.on { transform:none; opacity:1; }
.over .row { display:flex; gap:10px; }
.stat { flex:1; background:rgba(255,255,255,.05); border-radius:18px; padding:12px; }
.stat b { display:block; font-size:30px; font-weight:800; font-variant-numeric: tabular-nums; }
.stat span { color:#9AA6B6; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; }
.badge { display:inline-block; margin-left:6px; padding:2px 8px; border-radius:10px; background:#8FD3FF; color:#0F1620; font-size:11px; font-weight:800; vertical-align:middle; }
.btn { flex:1; height:50px; border-radius:25px; border:0; font: inherit; font-weight:800; font-size:16px; cursor:pointer; }
.btn.primary { background:#F3F7FB; color:#121821; }
.btn.ghost { background:rgba(255,255,255,.08); color:#EEF3F8; }
.over .row + .row { margin-top:12px; }
.notes { max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:24px; padding:22px; line-height:1.5; }
.notes h2 { margin:0 0 6px; font-size:22px; }
.notes h3 { margin:18px 0 6px; font-size:15px; }
.notes p, .notes li { color:var(--muted); font-size:14px; margin:0; }
.notes ul { padding-left:18px; margin:0; }
.notes b { color:var(--text); }
.k { display:inline-block; padding:1px 7px; border-radius:6px; border:1px solid var(--line); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="phone" id="phone" aria-label="Brisa, toque para voar" role="application">
    <canvas id="cv"></canvas>
    <div class="hud">
      <div class="score" id="score" style="display:none">0</div>
      <div class="ready" id="ready">
        <h1>Brisa</h1>
        <p id="bestReady">Recorde: 0</p>
        <span class="pill"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 11V6a2 2 0 1 1 4 0v5"/><path d="M13 10.5V9a2 2 0 1 1 4 0v4.5a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4.2-2.3L4 13.6a1.7 1.7 0 0 1 2.7-2L9 13.5"/></svg>Toque para voar</span>
      </div>
      <div class="over" id="over">
        <div class="row">
          <div class="stat"><span>Pontos</span><b id="oScore">0</b></div>
          <div class="stat"><span>Recorde <i class="badge" id="oNew" style="display:none;font-style:normal">NOVO</i></span><b id="oBest">0</b></div>
        </div>
        <div class="row"><button class="btn primary" id="again">Mais uma</button></div>
        <div class="row"><button class="btn ghost" id="rank">Ranking</button><button class="btn ghost" id="dare">Desafiar</button></div>
      </div>
    </div>
    <div class="top">
      <div class="chip" id="pauseBtn" title="Pausar" aria-label="Pausar"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg></div>
      <div class="chip" id="soundBtn" title="Som" aria-label="Som"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path id="w1" d="M15.5 8.5a5 5 0 0 1 0 7"/><path id="w2" d="M18.5 6a8.5 8.5 0 0 1 0 12"/></svg></div>
    </div>
  </div>
  <div class="notes">
    <h2>Brisa · prévia</h2>
    <p>Jogo de voar com um toque, <b>arte e personagem próprios do Chatyy</b>: a Bolhinha (balão de conversa com asa e os três pontinhos de "digitando") voando entre torres de sinal no entardecer.</p>
    <h3>Nomes propostos</h3>
    <ul><li><b>Brisa</b> (escolhido): curto, leve, funciona em pt/en/es</li><li>Voa Bolha</li><li>Zuum</li></ul>
    <h3>O que esta prévia já usa do app</h3>
    <ul>
      <li>Mesmo motor <b>determinístico</b> (passo fixo 1/120 s, inteiros, seed xorshift32): o servidor re-joga cada partida e confere a pontuação.</li>
      <li>Começa justo e acelera: velocidade sobe por ponto, o vão estreita e os vãos mudam mais de altura.</li>
      <li>3 camadas de parallax, partículas leves, 60 fps, sem bitmap e sem emoji.</li>
      <li>"Reduzir movimento" do sistema desliga tremida/partículas.</li>
    </ul>
    <h3>Controles</h3>
    <p>Toque / clique / <span class="k">Espaço</span> para bater asa. <span class="k">P</span> pausa. Recorde fica neste navegador.</p>
    <p style="margin-top:10px">Ranking e Desafiar aqui são só demonstração; no app viram ranking semanal (Geral, Amigos, País) e cartão "Bata meu recorde" na conversa.</p>
  </div>
</div>
<script>
(function(){
const __m = {}; const __f = {};
function __def(n, fn) { __f[n] = fn; }
function __req(n) { if (__m[n]) return __m[n].exports; const module = { exports: {} }; __m[n] = module; __f[n](module, module.exports, __req); return module.exports; }
${mod('engine')}
${mod('renderer')}
${mod('loop')}
const E = __req('./engine'), R = __req('./renderer'), L = __req('./loop');
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const $ = (id) => document.getElementById(id);
const rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let best = 0; try { best = Number(localStorage.getItem('brisa_best') || 0) || 0; } catch (e) {}
let sound = true; try { sound = localStorage.getItem('brisa_sound') !== '0'; } catch (e) {}
let ac = null;
function beep(f, d, type, vol) {
  if (!sound) return;
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, ac.currentTime); o.frequency.exponentialRampToValueAtTime(f * 1.5, ac.currentTime + d);
    g.gain.setValueAtTime(vol || 0.06, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + d); } catch (e) {}
}
function paintSound() { $('w1').style.opacity = sound ? 1 : 0; $('w2').style.opacity = sound ? 1 : 0; }
paintSound();
let run; const P = R.canvas2dPainter(ctx);
function seed() { return (Math.random() * 4294967295) >>> 0 || 1; }
function fresh() {
  run = L.createRunner({ seed: seed(), reduceMotion: rm,
    onStart: () => { $('ready').style.display = 'none'; $('score').style.display = ''; $('score').textContent = '0'; },
    onFlap: () => beep(520, 0.07, 'sine', 0.035),
    onScore: (s) => { $('score').textContent = String(s); beep(880, 0.12, 'triangle', 0.05); },
    onDeath: (d) => {
      beep(160, 0.35, 'sawtooth', 0.05); if (navigator.vibrate && !rm) navigator.vibrate(30);
      // confere com o re-jogo (o mesmo que o servidor faz)
      const chk = E.simulate(run.seed, d.ticks);
      if (!chk.ok || chk.score !== d.score) console.warn('replay diferente', chk, d);
      const isNew = d.score > best; if (isNew) { best = d.score; try { localStorage.setItem('brisa_best', String(best)); } catch (e) {} }
      $('oScore').textContent = String(d.score); $('oBest').textContent = String(best); $('oNew').style.display = isNew && d.score > 0 ? '' : 'none';
      setTimeout(() => $('over').classList.add('on'), 380);
    } });
  $('over').classList.remove('on'); $('ready').style.display = ''; $('score').style.display = 'none';
  $('bestReady').textContent = 'Recorde: ' + best;
}
fresh();
function size() { const r = cv.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
size(); window.addEventListener('resize', size);
let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  run.frame(dt);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  run.draw(P, { w: cv.width, h: cv.height });
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
function tap(ev) {
  if (ev && ev.target && ev.target.closest && (ev.target.closest('.over') || ev.target.closest('.top'))) return;
  if (ev) ev.preventDefault();
  if (run.phase === 'dead') return;
  run.tap();
}
$('phone').addEventListener('pointerdown', tap);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); if (run.phase === 'dead') { if ($('over').classList.contains('on')) { fresh(); run.tap(); } } else run.tap(); }
  if (e.code === 'KeyP') run.pause();
});
$('again').addEventListener('click', () => { fresh(); run.tap(); });
$('rank').addEventListener('click', () => alert('No app: ranking semanal Geral / Amigos / País, reinicia segunda 00:00 (Brasília).'));
$('dare').addEventListener('click', () => alert('No app: manda um cartão "Bata meu recorde: ' + ($('oScore').textContent) + '" na conversa, com a mesma fase.'));
$('soundBtn').addEventListener('click', () => { sound = !sound; try { localStorage.setItem('brisa_sound', sound ? '1' : '0'); } catch (e) {} paintSound(); });
$('pauseBtn').addEventListener('click', () => run.pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) run.pause(); });
})();
</script>
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log('ok', out, html.length, 'bytes');
