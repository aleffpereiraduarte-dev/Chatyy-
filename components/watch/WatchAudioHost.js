// components/watch/WatchAudioHost.js — [assistir-junto fase 2 20/10] player do "Ouvir junto" na RAIZ do app.
// A música continua ao sair da sala, em outras telas e com o app em 2º plano/tela bloqueada (igual
// Spotify): enquanto WT.getListening() aponta uma conversa com sessão de música ao vivo, este host
// mantém o WatchPlayer (expo-video, Now Playing na tela de bloqueio) + presença na sala (join/heartbeat).
// Para quando: a sessão acaba/vira vídeo, o usuário fecha no mini-player, ou entra numa ligação no iOS
// sem o binário com o patch (WT.callPlaybackBlocked). Kill: globalThis.__chatyy_watch_bg = false.
import React, { useEffect, useState } from 'react';
import * as WT from '../../services/watchTogether';
import WatchPlayer from './WatchPlayer';
import { useAuth } from '../../context/AuthContext';

export default function WatchAudioHost() {
  const { user } = useAuth();
  const me = String((user && user.email) || '').toLowerCase();
  const [cid, setCid] = useState(WT.getListening());
  const [s, setS] = useState(() => (cid ? WT.getSession(cid) : null));
  const [call, setCall] = useState(WT.inCall());
  const [duck, setDuck] = useState(WT.isCallSpeaking());
  useEffect(() => WT.onListening(setCid), []);
  useEffect(() => WT.onCallSpeaking(setDuck), []);
  useEffect(() => {
    let off = null;
    try { off = require('../../services/callState').subscribeCallState(() => { const c = WT.inCall(); setCall(c); if (!c) WT.setCallSpeaking(false); }); } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);
  useEffect(() => {
    if (!cid) { setS(null); return undefined; }
    setS(WT.getSession(cid));
    const off = WT.subscribe(cid, (x) => {
      setS(x);
      if (!x || x.status !== 'live' || x.kind !== 'music') WT.setListening(null);
    });
    const leave = WT.enterRoom(cid); // presença "ouvindo" + heartbeat + poll (modo HTTP)
    return () => { off(); leave(); };
  }, [cid]);
  let bgOk = true; try { bgOk = globalThis.__chatyy_watch_bg !== false && WT.watchEnabled(); } catch {}
  if (!bgOk || !cid || !WT.isLive(s) || s.kind !== 'music') return null;
  if (call && WT.callPlaybackBlocked()) return null;
  return <WatchPlayer cid={cid} state={s} me={me} audioOnly music duck={duck} onSync={(st) => WT.setSyncStatus(cid, st)} />;
}
