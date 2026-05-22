/**
 * CallContext — Global call state that persists across navigation.
 *
 * Provides:
 *  - isInCall        boolean
 *  - callStartTime   Date | null
 *  - callData        { callId, contactName, contactEmail, isVideo, conversationId, isCaller } | null
 *  - startCall(data) sets call active with metadata
 *  - endCall()       clears call state
 *  - getCallDuration() returns elapsed seconds
 */
import React, { createContext, useContext, useState, useRef, useCallback } from 'react';

const CallContext = createContext(null);

export function CallProvider({ children }) {
  const [callData, setCallData] = useState(null);
  const [callStartTime, setCallStartTime] = useState(null);
  const callDataRef = useRef(null);
  const startTimeRef = useRef(null);

  const startCall = useCallback((data) => {
    // data: { callId, contactName, contactEmail, isVideo, conversationId, isCaller }
    const now = new Date();
    setCallData(data);
    setCallStartTime(now);
    callDataRef.current = data;
    startTimeRef.current = now;
  }, []);

  const endCall = useCallback(() => {
    // [WAVE 135 2026-05-22] Before flipping JS state, tell the native
    // CallKit (iOS) / ConnectionService (Android) the call is over.
    // Without this dispatch the native call UI stays mounted forever —
    // user reports "se desliga a ligacao pelo app o nativo ainda fica
    // aberto" because the in-app hangup button only cleared CallContext
    // and the OS-managed call screen never got reportEndCallWithUUID.
    // Two systems in conflict: JS hangup must propagate to the native side.
    //
    // Also fire chatEndCall to the backend so the peer's chat_call_state
    // row flips to ended and the global GC cron doesn't have to wait for
    // its 60s heartbeat-timeout to mark this call dead.
    try {
      const callId = callDataRef.current?.callId;
      if (callId) {
        // Lazy-require both modules to avoid circular import + so a missing
        // native binding (e.g. on web) silently degrades to JS-only cleanup
        // instead of throwing and breaking the hangup flow entirely.
        try {
          const ck = require('../modules/expo-callkit').default || require('../modules/expo-callkit');
          if (ck?.endCall) ck.endCall(callId, 'remoteEnded');
        } catch {}
        try {
          // [WAVE 139, GPT-5.5-pro C1.3] `chatEndCall` NÃO EXISTE em services/api.js —
          // a função certa é `chatCallActiveClose`. Antes esta chamada falhava
          // silenciosamente (api?.chatEndCall falsy → no-op), então o peer
          // `chat_call_state` row ficava até o GC cron de 60s timeout marcar
          // dead. Agora chama o endpoint real com reason="hangup".
          const api = require('../services/api');
          const close = api?.chatCallActiveClose || api?.chatEndCall;
          if (close) close(callId, 'hangup').catch(() => {});
        } catch {}
      }
    } catch {}

    setCallData(null);
    setCallStartTime(null);
    callDataRef.current = null;
    startTimeRef.current = null;
  }, []);

  const getCallDuration = useCallback(() => {
    if (!startTimeRef.current) return 0;
    return Math.floor((Date.now() - startTimeRef.current.getTime()) / 1000);
  }, []);

  const value = {
    isInCall: !!callData,
    callData,
    callStartTime,
    startCall,
    endCall,
    getCallDuration,
  };

  return (
    <CallContext.Provider value={value}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return ctx;
}

export default CallContext;
