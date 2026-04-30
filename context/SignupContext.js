import { createContext, useContext, useState, useCallback } from 'react';

const SignupContext = createContext(null);

const INITIAL_STATE = {
  firstName: '',
  lastName: '',
  birthday: '',
  gender: '',
  username: '',
  domain: 'chatyy.com.br',
  usernameAvailable: null,
  suggestions: [],
  password: '',
  passwordStrength: 0,
  phone: '',
  countryCode: 'BR',
  phoneVerified: false,
  verifyToken: '',
  recoveryEmail: '',
  agreedTerms: false,
};

export function SignupProvider({ children }) {
  // Lazy initializer + spread evita compartilhar a mesma referência do
  // INITIAL_STATE entre runs (mutações acidentais vazariam pra const).
  const [data, setData] = useState(() => ({ ...INITIAL_STATE }));

  const update = useCallback((fields) => {
    setData(prev => ({ ...prev, ...fields }));
  }, []);

  const reset = useCallback(() => {
    setData(() => ({ ...INITIAL_STATE }));
  }, []);

  const fullName = data.firstName && data.lastName
    ? `${data.firstName} ${data.lastName}`
    : data.firstName || '';

  const email = data.username
    ? `${data.username}@${data.domain}`
    : '';

  return (
    <SignupContext.Provider value={{ data, update, reset, fullName, email }}>
      {children}
    </SignupContext.Provider>
  );
}

export function useSignup() {
  const ctx = useContext(SignupContext);
  if (!ctx) throw new Error('useSignup must be inside SignupProvider');
  return ctx;
}
