// "Ask counter to approve" pad (spec §10.3): someone at the counter types
// their own employee code + 4-digit PIN on the helper's phone to OK a
// discount over the helper's limit. The PIN goes only with that one sale
// request and is never kept: the parent clears it after every try.
//
// <OverridePad discountText="15% off" busy error onApprove={(code, pin) => …} onCancel />
// approver="manager" words it for counter staff asking a manager or the owner
// (Quick Checkout); the default "counter" is the helper phone.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const WORDS = {
  counter: {
    title: 'Ask counter to approve',
    body: 'Hand the phone to someone at the counter.',
    who: "the counter person's",
    a11y: "Counter person's",
  },
  manager: {
    title: 'Ask a manager to approve',
    body: 'Ask a manager or the owner to type their own code and PIN.',
    who: "the manager's",
    a11y: "Manager's",
  },
};

export default function OverridePad({ discountText, busy, error, onApprove, onCancel, approver = 'counter' }) {
  const w = WORDS[approver] || WORDS.counter;
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [localError, setLocalError] = useState('');
  const pinRef = useRef(null);

  // Every answer from the server clears the PIN (never left on the phone).
  useEffect(() => {
    if (error) setPin('');
  }, [error]);

  const submit = () => {
    if (busy) return;
    const c = code.trim();
    if (!c) { setLocalError(`Type ${w.who} code first.`); return; }
    if (!/^\d{4}$/.test(pin)) { setLocalError('Type their 4-digit PIN.'); return; }
    setLocalError('');
    const p = pin;
    setPin('');
    onApprove(c, p);
  };

  const shown = localError || error;

  return (
    <View style={styles.wrap}>
      <View style={styles.iconCircle}>
        <Ionicons name="shield-checkmark" size={36} color={Colors.primary} />
      </View>
      <Text style={styles.title}>{w.title}</Text>
      <Text style={styles.body}>
        {w.body}{discountText ? ` They are approving ${discountText}.` : ''}
      </Text>

      <Text style={styles.label}>Their code</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={(t) => { setCode(t.replace(/[^0-9A-Za-z]/g, '')); if (localError) setLocalError(''); }}
        keyboardType="number-pad"
        autoFocus
        returnKeyType="next"
        onSubmitEditing={() => pinRef.current && pinRef.current.focus()}
        placeholder="e.g. 1001"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel={`${w.a11y} employee code`}
        autoComplete="off"
      />

      <Text style={styles.label}>Their PIN</Text>
      <TextInput
        ref={pinRef}
        style={[styles.input, styles.pinInput]}
        value={pin}
        onChangeText={(t) => { setPin(t.replace(/\D/g, '').slice(0, 4)); if (localError) setLocalError(''); }}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={4}
        onSubmitEditing={submit}
        returnKeyType="done"
        accessibilityLabel={`${w.a11y} 4-digit PIN`}
        autoComplete="off"
        textContentType="oneTimeCode"
      />

      {shown ? (
        <View style={styles.errorBox} accessibilityLiveRegion="assertive">
          <Ionicons name="alert-circle" size={22} color={Colors.error} />
          <Text style={styles.errorText}>{shown}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.primary, busy && styles.disabled]}
        onPress={submit}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Approve the discount"
        accessibilityState={{ disabled: !!busy }}
        activeOpacity={0.8}
      >
        {busy ? <ActivityIndicator color={Colors.white} /> : <Ionicons name="checkmark-circle" size={26} color={Colors.white} />}
        <Text style={styles.primaryText}>{busy ? 'Checking…' : 'Approve'}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondary}
        onPress={onCancel}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Back, change the discount"
        activeOpacity={0.7}
      >
        <Text style={styles.secondaryText}>Back</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  iconCircle: {
    width: 64, height: 64, borderRadius: BorderRadius.full, backgroundColor: Colors.primaryGlow,
    alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  body: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs, marginBottom: Spacing.lg, lineHeight: 22 },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  input: {
    minHeight: 56, borderWidth: 2, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    backgroundColor: Colors.surface, marginBottom: Spacing.md, fontVariant: ['tabular-nums'],
  },
  pinInput: { letterSpacing: 8 },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, backgroundColor: Colors.errorLight,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md,
  },
  errorText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text, lineHeight: 22 },
  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 60, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  disabled: { opacity: 0.6 },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
  secondary: {
    minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  secondaryText: { color: Colors.textSecondary, fontSize: FontSize.lg, fontWeight: '600' },
});
