import React, { createContext, useContext } from 'react';

const BiometricContext = createContext({});

export function BiometricProvider({ children }) {
  return (
    <BiometricContext.Provider value={{
      isLocked: false,
      biometricEnabled: false,
      biometricAvailable: false,
      toggleBiometric: async () => false,
      authenticate: async () => false,
    }}>
      {children}
    </BiometricContext.Provider>
  );
}

export const useBiometric = () => useContext(BiometricContext);
