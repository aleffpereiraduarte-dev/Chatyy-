/**
 * verify-phone-required — blocks the app for accounts that haven't verified their phone.
 *
 * Server returns needs_phone_verification=true when the user's profile is missing
 * verified_phone or phone_verified=false. The user must complete OTP verification
 * before gaining access to the rest of the app.
 */
import { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import * as api from '../services/api';

export default function VerifyPhoneRequiredScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { user, refreshAuth, logout } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone'); // 'phone' | 'code'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const codeRef = useRef(null);

  const requestOtp = async () => {
    setError('');
    let normalized = phone.trim();
    if (!normalized) { setError('Digite seu número'); return; }
    if (normalized[0] === '+') {
      // Já tem prefixo internacional — só sanitizar separadores (espaços/hífens).
      normalized = '+' + normalized.slice(1).replace(/\D/g, '');
    } else {
      const digits = normalized.replace(/\D/g, '');
      // Default Brasil: prefixa +55 se ainda não veio. Antes números locais
      // longos (ex.: 11999998888) viravam '+11999998888' (US).
      normalized = '+' + (digits.startsWith('55') ? digits : ('55' + digits));
    }
    setLoading(true);
    try {
      const r = await api.requestPhoneOtp(normalized);
      if (r?.success) {
        setPhone(normalized);
        setStep('code');
        setTimeout(() => codeRef.current?.focus(), 100);
      } else {
        setError(r?.message || 'Erro ao enviar código');
      }
    } catch (e) {
      setError('Erro de conexão');
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    setError('');
    if (code.length !== 6) { setError('Código deve ter 6 dígitos'); return; }
    setLoading(true);
    try {
      const r = await api.verifyPhoneOtp(phone, code);
      if (r?.success) {
        // Refresh user data — server now returns needs_phone_verification=false
        await refreshAuth();
        router.replace('/inbox');
      } else {
        setError(r?.message || 'Código inválido');
      }
    } catch (e) {
      setError('Erro de conexão');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, justifyContent: 'center' }}>
        <View style={{ alignItems: 'center', marginBottom: 32 }}>
          <Text style={{ fontSize: 56 }}>📱</Text>
          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 16, textAlign: 'center' }}>
            Verifique seu telefone
          </Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 20 }}>
            Pra usar o Chatyy você precisa{'\n'}verificar seu número de telefone.
          </Text>
        </View>

        {step === 'phone' ? (
          <>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6 }}>Telefone (com DDD/código do país)</Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="+55 11 99999-9999"
              placeholderTextColor={colors.textTertiary}
              keyboardType="phone-pad"
              autoFocus
              style={{
                backgroundColor: colors.surface,
                color: colors.text,
                fontSize: 18,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                marginBottom: 12,
              }}
            />
            {error ? <Text style={{ color: '#ef4444', marginBottom: 12 }}>{error}</Text> : null}
            <TouchableOpacity
              onPress={requestOtp}
              disabled={loading}
              style={{
                backgroundColor: colors.primary,
                padding: 16,
                borderRadius: 12,
                alignItems: 'center',
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? <ActivityIndicator color="#fff" /> : (
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Enviar código</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6 }}>
              Código enviado para {phone}
            </Text>
            <TextInput
              ref={codeRef}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              maxLength={6}
              style={{
                backgroundColor: colors.surface,
                color: colors.text,
                fontSize: 24,
                letterSpacing: 8,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                marginBottom: 12,
                textAlign: 'center',
              }}
            />
            {error ? <Text style={{ color: '#ef4444', marginBottom: 12 }}>{error}</Text> : null}
            <TouchableOpacity
              onPress={verifyCode}
              disabled={loading || code.length !== 6}
              style={{
                backgroundColor: colors.primary,
                padding: 16,
                borderRadius: 12,
                alignItems: 'center',
                opacity: (loading || code.length !== 6) ? 0.6 : 1,
              }}
            >
              {loading ? <ActivityIndicator color="#fff" /> : (
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Verificar</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStep('phone')} style={{ marginTop: 12, alignItems: 'center' }}>
              <Text style={{ color: colors.primary, fontSize: 14 }}>Mudar número</Text>
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity
          onPress={() => {
            Alert.alert('Sair', 'Deseja sair da conta?', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Sair', style: 'destructive', onPress: () => { logout(); router.replace('/login'); } },
            ]);
          }}
          style={{ marginTop: 32, alignItems: 'center' }}
        >
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Sair</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
