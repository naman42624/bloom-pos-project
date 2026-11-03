// Public join page (/join/<token>): a helper opens the owner's one-time link
// on their own phone, sets a 4-digit PIN, and is signed in on that phone.
// Spec §8.3. App.js renders this inside AuthProvider (completeJoin stores the
// session) but outside RootNavigator, so no staff screen or route runs here.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, ScrollView, Platform,
} from 'react-native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TOO_MANY = 'Too many tries — wait a minute and try again.';
const NO_INTERNET = "Couldn't reach the shop — check the internet and tap Try again.";
const SAVE_NO_INTERNET = "Couldn't save — check the internet and tap Save PIN again.";
const MISMATCH = "The two PINs don't match — try again";
const NEED_FOUR = 'Type 4 numbers for your PIN.';

const digitsOnly = (v) => String(v || '').replace(/\D/g, '').slice(0, 4);

export default function JoinScreen({ token, onJoined }) {
  const { completeJoin, personalDevice } = useAuth();
  const guardSubmit = useSubmitGuard();
  // loading | form | refused | retry
  const [phase, setPhase] = useState('loading');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const firstRef = useRef(null);
  const secondRef = useRef(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const res = await api.getJoinInfo(token);
      setName(res.data?.name || '');
      setPhase('form');
    } catch (err) {
      if (err?.status === 410 || err?.status === 401 || err?.status === 404) {
        setMessage(err.message);
        setPhase('refused');
      } else {
        setMessage(err?.status === 429 ? TOO_MANY : NO_INTERNET);
        setPhase('retry');
      }
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const onFirstChange = (v) => {
    const next = digitsOnly(v);
    setPin(next);
    setFormError('');
    if (next.length === 4 && secondRef.current) secondRef.current.focus();
  };

  const onSecondChange = (v) => {
    setPin2(digitsOnly(v));
    setFormError('');
  };

  const startOver = (msg) => {
    setPin('');
    setPin2('');
    setFormError(msg);
    if (firstRef.current) firstRef.current.focus();
  };

  const handleSave = async () => {
    if (pin.length !== 4) { startOver(NEED_FOUR); return; }
    if (pin2.length !== 4) {
      setFormError(NEED_FOUR);
      if (secondRef.current) secondRef.current.focus();
      return;
    }
    if (pin !== pin2) { startOver(MISMATCH); return; }
    setSaving(true);
    try {
      const res = await api.joinWithPin(token, pin);
      await completeJoin(res.data);
      if (onJoined) onJoined();
    } catch (err) {
      if (err?.status === 410 || err?.status === 401) {
        setMessage(err.message);
        setPhase('refused');
      } else if (err?.status === 429) {
        setFormError(TOO_MANY);
      } else if (err?.status === 400) {
        startOver(err.message || NEED_FOUR);
      } else {
        setFormError(SAVE_NO_INTERNET);
      }
    } finally {
      setSaving(false);
    }
  };

  let body;
  if (phase === 'loading') {
    body = <ActivityIndicator size="large" color={Colors.primary} />;
  } else if (phase === 'refused') {
    body = (
      <>
        <Text style={styles.message}>{message}</Text>
        {/* Already set up on this phone (e.g. tapped the old link again):
            one tap back to their own PIN pad. */}
        {personalDevice && onJoined ? (
          <TouchableOpacity style={styles.primaryBtn} onPress={onJoined} accessibilityRole="button">
            <Text style={styles.primaryBtnText}>Open the app</Text>
          </TouchableOpacity>
        ) : null}
      </>
    );
  } else if (phase === 'retry') {
    body = (
      <>
        <Text style={styles.message}>{message}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={load} accessibilityRole="button">
          <Text style={styles.primaryBtnText}>Try again</Text>
        </TouchableOpacity>
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.greeting}>Hi {name} 👋</Text>
        <Text style={styles.subtitle}>Set a 4-digit PIN you'll remember</Text>

        <Text style={styles.label}>Your PIN</Text>
        <TextInput
          ref={firstRef}
          style={styles.input}
          value={pin}
          onChangeText={onFirstChange}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={4}
          secureTextEntry
          autoFocus
          autoComplete="off"
          accessibilityLabel="Your PIN"
          returnKeyType="next"
          onSubmitEditing={() => secondRef.current && secondRef.current.focus()}
        />

        <Text style={styles.label}>Type it again</Text>
        <TextInput
          ref={secondRef}
          style={styles.input}
          value={pin2}
          onChangeText={onSecondChange}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={4}
          secureTextEntry
          autoComplete="off"
          accessibilityLabel="Type your PIN again"
          returnKeyType="done"
          onSubmitEditing={guardSubmit(handleSave)}
        />

        <View style={styles.errorLine}>
          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        </View>

        <TouchableOpacity
          style={[styles.primaryBtn, saving && styles.primaryBtnBusy]}
          onPress={guardSubmit(handleSave)}
          disabled={saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving, busy: saving }}
        >
          {saving
            ? <ActivityIndicator color={Colors.textOnPrimary} />
            : <Text style={styles.primaryBtnText}>Save PIN</Text>}
        </TouchableOpacity>
      </>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>{body}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.background },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: Spacing.md },
  card: {
    width: '100%', maxWidth: 420, alignSelf: 'center', backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg, padding: Spacing.lg, alignItems: 'stretch',
  },
  greeting: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  subtitle: { fontSize: FontSize.lg, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm, marginBottom: Spacing.lg },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  input: {
    minHeight: 64, borderWidth: 2, borderColor: Colors.border, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, color: Colors.text, fontSize: FontSize.xxl, textAlign: 'center',
    letterSpacing: 12, paddingHorizontal: Spacing.md,
  },
  errorLine: { minHeight: 28, justifyContent: 'center', marginTop: Spacing.sm },
  errorText: { color: Colors.error, fontSize: FontSize.md, textAlign: 'center' },
  message: { fontSize: FontSize.lg, color: Colors.text, textAlign: 'center', lineHeight: 28 },
  primaryBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md, paddingHorizontal: Spacing.lg,
  },
  primaryBtnBusy: { opacity: 0.6 },
  primaryBtnText: { color: Colors.textOnPrimary, fontSize: FontSize.lg, fontWeight: '700' },
});
