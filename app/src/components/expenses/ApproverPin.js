/**
 * ApproverPin: the inline "A manager or owner must confirm" box above the
 * Give button (spec 4.2, 5.1). Shown only after the server answered 409
 * needs_pin, so an approver is never sent when no PIN is needed (a sent
 * approver always records a PIN try).
 *
 *   A manager or owner must confirm
 *   That's more than the ₹500 daily advance limit. ...
 *   Who is confirming?   (Asha) (Owner)
 *   Their PIN            [ •••• ]
 *   Wrong tries count toward your PIN lockout.
 *
 * Names come from GET /staff-money/approvers (managers linked to this shop
 * and the owner, each with an approval PIN). The person getting the money is
 * never offered. With nobody to pick, plain help copy says what to do.
 *
 * Props:
 *   locationId, recipientId
 *   reason        the server's plain message (why a PIN is needed)
 *   approverId, onApproverChange(id)
 *   pin, onPinChange(text)
 *   error         a PIN answer from the server (wrong PIN, can't confirm)
 *   locked        the last answer was 423 (too many wrong tries)
 *   onSubmit?     the PIN box's keyboard "done"
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export const NO_APPROVER_MESSAGE = 'No manager has an approval PIN yet. The owner can set one in Settings → Approval PIN.';
export const LOCKOUT_NOTE = 'Wrong tries count toward your PIN lockout.';

export default function ApproverPin({
  locationId, recipientId, reason, approverId, onApproverChange, pin, onPinChange, error, locked = false, onSubmit,
}) {
  const [approvers, setApprovers] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const pinRef = useRef(null);

  const load = () => {
    setState('loading');
    api.getStaffMoneyApprovers({ location_id: locationId })
      .then((res) => { setApprovers(res.data || []); setState('ready'); })
      .catch(() => setState('error'));
  };
  useEffect(() => { if (locationId) load(); }, [locationId]);

  const list = approvers.filter((a) => Number(a.id) !== Number(recipientId));
  // Only one person can confirm: pick them at once (one tap less).
  useEffect(() => {
    if (state === 'ready' && list.length === 1 && Number(approverId) !== Number(list[0].id)) onApproverChange(list[0].id);
    if (approverId && state === 'ready' && !list.some((a) => Number(a.id) === Number(approverId))) onApproverChange(null);
  }, [state, approvers, recipientId]);

  return (
    <View style={styles.box}>
      <View style={styles.titleRow}>
        <Ionicons name="shield-checkmark-outline" size={22} color={Colors.primary} />
        <Text style={styles.title}>A manager or owner must confirm</Text>
      </View>
      {!!reason && <Text style={styles.reason}>{reason}</Text>}

      {state === 'loading' && <ActivityIndicator color={Colors.primary} style={styles.spinner} />}
      {state === 'error' && (
        <TouchableOpacity onPress={load} style={styles.retry} accessibilityRole="button">
          <Text style={styles.errorText}>Could not load who can confirm. Tap to try again.</Text>
        </TouchableOpacity>
      )}
      {state === 'ready' && list.length === 0 && <Text style={styles.help}>{NO_APPROVER_MESSAGE}</Text>}

      {state === 'ready' && list.length > 0 && (
        <>
          <Text style={styles.label}>Who is confirming?</Text>
          <View style={styles.chips}>
            {list.map((a) => {
              const active = Number(a.id) === Number(approverId);
              return (
                <TouchableOpacity
                  key={a.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => { onApproverChange(a.id); setTimeout(() => pinRef.current?.focus(), 50); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${a.name} confirms`}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{a.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.label}>Their PIN</Text>
          <TextInput
            ref={pinRef}
            style={[styles.input, !!error && styles.inputError]}
            value={pin}
            onChangeText={(t) => onPinChange(t.replace(/[^0-9]/g, '').slice(0, 4))}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            placeholder="4-digit PIN"
            placeholderTextColor={Colors.textLight}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            autoComplete="off"
            textContentType="oneTimeCode"
            accessibilityLabel="PIN of the person confirming"
          />
          {!!error && <Text style={styles.errorText}>{error}</Text>}
          {locked && <Text style={styles.help}>Pick someone else to confirm, or try again later.</Text>}
          <Text style={styles.note}>{LOCKOUT_NOTE}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: Spacing.md, padding: Spacing.md, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.background,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  reason: { fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs },
  spinner: { marginTop: Spacing.sm },
  retry: { minHeight: 44, justifyContent: 'center' },
  help: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.sm },
  label: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    minHeight: 44, maxWidth: 200, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.lg, letterSpacing: 6, color: Colors.text, backgroundColor: Colors.surface,
  },
  inputError: { borderColor: Colors.error },
  errorText: { fontSize: FontSize.md, color: Colors.error, marginTop: Spacing.xs },
  note: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm },
});
