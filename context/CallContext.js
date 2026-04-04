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
