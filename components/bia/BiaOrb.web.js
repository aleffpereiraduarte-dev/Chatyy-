// [2026-10-15 bia-design] ORB da Bia — WEB (Skia é stub no web, ver metro.config).
// Esfera monocromática em CSS puro (camadas de gradiente + desfoque girando em
// keyframes, composição na GPU). Volume (getLevel) aplicado por rAF direto no
// estilo do nó — nenhum render React por quadro. prefers-reduced-motion → parado.
import React, { memo, useEffect, useRef } from 'react';
import { useReducedMotion } from '../reducedMotion';
import { THEME_V2 } from '../../constants/theme';

const CSS = `
.bia-orb{position:relative;flex-shrink:0;pointer-events:none}
.bia-orb .bo-glow{position:absolute;inset:-22%;border-radius:50%;filter:blur(calc(var(--s)*0.14));opacity:var(--go);transition:opacity .6s ease;background:radial-gradient(circle,var(--gc) 0%,transparent 66%)}
.bia-orb .bo-scale{position:absolute;inset:0;will-change:transform;transition:transform 90ms linear}
.bia-orb .bo-breathe{position:absolute;inset:0;animation:bo-breathe var(--bd) ease-in-out infinite}
.bia-orb .bo-sphere{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:radial-gradient(circle at 40% 32%,#3b3b41 0%,#151518 52%,#050506 100%);box-shadow:inset 0 0 calc(var(--s)*0.10) rgba(255,255,255,var(--rim)),inset 0 calc(var(--s)*-0.06) calc(var(--s)*0.12) rgba(0,0,0,.55);isolation:isolate}
.bia-orb .bo-sw1,.bia-orb .bo-sw2{position:absolute;inset:-25%;border-radius:50%;mix-blend-mode:screen}
.bia-orb .bo-sw1{background:conic-gradient(from 0deg,transparent 0deg,rgba(255,255,255,.34) 50deg,transparent 110deg,rgba(255,255,255,.16) 190deg,transparent 250deg,rgba(255,255,255,.28) 310deg,transparent 360deg);filter:blur(calc(var(--s)*0.09));animation:bo-spin var(--sp) linear infinite}
.bia-orb .bo-sw2{background:radial-gradient(ellipse 46% 22% at 34% 64%,rgba(255,255,255,.38),transparent 70%),radial-gradient(ellipse 30% 16% at 70% 32%,rgba(255,255,255,.26),transparent 70%);filter:blur(calc(var(--s)*0.05));animation:bo-spin calc(var(--sp)*1.45) linear infinite reverse}
.bia-orb .bo-spec{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 33% 25%,rgba(255,255,255,.62) 0%,rgba(255,255,255,.12) 16%,transparent 34%)}
.bia-orb .bo-edge{position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,var(--edge))}
@keyframes bo-spin{to{transform:rotate(360deg)}}
@keyframes bo-breathe{0%,100%{transform:scale(1)}50%{transform:scale(var(--bs))}}
@keyframes bo-breathe2{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(var(--bs));filter:brightness(1.18)}}
.bia-orb[data-v2="1"] .bo-breathe{animation-name:bo-breathe2}
.bia-orb[data-rm="1"] *,.bia-orb[data-rm="1"]{animation:none!important;transition:none!important}
@media (prefers-reduced-motion: reduce){.bia-orb *{animation:none!important;transition:none!important}}
`;
let _injected = false;
function inject() {
  if (_injected || typeof document === 'undefined') return;
  _injected = true;
  try { const el = document.createElement('style'); el.setAttribute('data-bia-orb', '1'); el.textContent = CSS; document.head.appendChild(el); } catch {}
}

const MODE = {
  // [2026-10-20 grafite] tema v2: respira em 4 s até 1,03 (+ brilho, CSS abaixo)
  idle: THEME_V2 ? { sp: '14s', bd: '4s', bs: 1.03, go: 0.32 } : { sp: '14s', bd: '5.5s', bs: 1.02, go: 0.32 },
  thinking: { sp: '3.6s', bd: '1.6s', bs: 1.055, go: 0.5 },
  listening: { sp: '7s', bd: '3s', bs: 1.03, go: 0.42 },
  speaking: { sp: '4.2s', bd: '1.2s', bs: 1.04, go: 0.55 },
};

export function BiaOrbLite(props) { return <BiaOrb {...props} />; }

function BiaOrb({ size = 120, mode = 'idle', getLevel, isDark = false, paused = false, animated = true }) {
  inject();
  const reduceMotion = useReducedMotion();
  const scaleRef = useRef(null);
  const getRef = useRef(getLevel);
  getRef.current = getLevel;
  const m = MODE[mode] || MODE.idle;
  const still = reduceMotion || !animated || paused;
  const live = (mode === 'listening' || mode === 'speaking') && !still;

  useEffect(() => {
    const el = scaleRef.current;
    if (!live || !el) { if (el) el.style.transform = 'scale(1)'; return undefined; }
    let raf = 0; let cur = 0; const t0 = performance.now();
    const tick = (now) => {
      let v = 0;
      try { v = Number(getRef.current?.()) || 0; } catch { v = 0; }
      if (!getRef.current && mode === 'speaking') { const t = (now - t0) / 1000; v = 0.3 + 0.22 * Math.sin(t * 7.3) * Math.sin(t * 3.1); }
      cur += (Math.max(0, Math.min(1, v)) - cur) * 0.25;
      el.style.transform = `scale(${(1 + cur * 0.12).toFixed(4)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); };
  }, [live, mode]);

  const style = {
    width: size, height: size,
    '--s': `${size}px`, '--sp': m.sp, '--bd': m.bd, '--bs': m.bs,
    '--go': isDark ? Math.min(1, m.go * 0.9) : m.go,
    '--gc': isDark ? 'rgba(255,255,255,0.42)' : 'rgba(20,20,24,0.55)',
    '--rim': isDark ? 0.3 : 0.2,
    '--edge': isDark ? 0.14 : 0,
  };
  return (
    <div className="bia-orb" data-rm={still ? '1' : '0'} data-v2={THEME_V2 ? '1' : '0'} style={style} aria-hidden="true">
      <div className="bo-glow" />
      <div className="bo-scale" ref={scaleRef}>
        <div className="bo-breathe">
          <div className="bo-sphere">
            <div className="bo-sw1" />
            <div className="bo-sw2" />
            <div className="bo-spec" />
          </div>
          <div className="bo-edge" />
        </div>
      </div>
    </div>
  );
}

export default memo(BiaOrb);
