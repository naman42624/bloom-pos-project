/**
 * PayBackSheet — "Pay back" on a Shop owes line (spec 4.4, 4.7, 5.5).
 *
 *   Pay back Ramesh                                ✕
 *   The shop owes Ramesh ₹120
 *   Amount        ₹ [ 120 ]        (part payments allowed)
 *   Paid by       [ Cash | UPI ]
 *   [           Pay back ₹120           ]
 *   Keep as my money                 (owner, own line only)
 *   Write off ›                      (owner only: asks for a reason)
 *
 * Cash comes out of the open register; with the register closed it says so
 * and opens it right here (OpenRegisterForm), UPI works either way.
 *
 * Props: visible, line ({ id, user_id, user_name, remaining }), locationId,
 *        onClose(), onDone({ message })
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { showConfirm } from '../../utils/alert';
import { payBackCheck, firstName, rupeesText } from '../../utils/staffMoney';
import MethodSwitch from './MethodSwitch';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const CLOSED_COPY = 'Open the register to give cash — or pick UPI.';
const LOST_ERROR = 'No answer from the shop computer. Close this and check the card before trying again.';
const isRegisterClosedError = (err) => err && err.status === 400 && /open the register/i.test(err.message || '');
const METHODS = [{ key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }];

export default function PayBackSheet({ visible, line, locationId, onClose, onDone }) {
  const { user } = useAuth();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registerOpen, setRegisterOpen] = useState(null); // null = not known yet
  const [needRegister, setNeedRegister] = useState(null); // null | 'open' | 'pay'
  const [writeOff, setWriteOff] = useState(false);
  const [reason, setReason] = useState('');
  const guard = useSubmitGuard();

  const remaining = line ? Number(line.remaining) || 0 : 0;
  const isOwner = user?.role === 'owner';
  const ownLine = !!line && Number(line.user_id) === Number(user?.id);
  const name = line ? firstName(line.user_name) : '';

  const loadRegister = () => {
    if (!locationId) return;
    api.getRegisterStatus(locationId)
      .then((res) => setRegisterOpen(res?.isOpen === true))
      .catch(() => setRegisterOpen(null)); // the server checks again
  };

  useEffect(() => {
    if (!visible || !line) return;
    setAmount(String(remaining));
    setMethod('cash');
    setBusy(false);
    setError('');
    setNeedRegister(null);
    setWriteOff(false);
    setReason('');
    setRegisterOpen(null);
    loadRegister();
  }, [visible, line && line.id]);

  const checked = payBackCheck(amount, remaining, line ? line.user_name : '');
  const cashClosed = method === 'cash' && registerOpen === false;

  const finish = (message) => {
    setBusy(false);
    onDone && onDone({ message });
    onClose && onClose();
  };
  const fail = (err) => {
    setBusy(false);
    if (isRegisterClosedError(err)) { setRegisterOpen(false); setError(CLOSED_COPY); return; }
    if (!err || !err.status || err.status >= 500) { setError(LOST_ERROR); return; }
    setError(err.message);
  };

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api.payBackOwes(line.id, { amount: checked.amount, method });
      const left = Math.max(0, Math.round((remaining - checked.amount) * 100) / 100);
      finish(left > 0
        ? `Paid back ${rupeesText(checked.amount)} to ${name}. The shop still owes ${rupeesText(left)}.`
        : `Paid back ${rupeesText(checked.amount)} to ${name}.`);
    } catch (err) {
      fail(err);
    }
  };

  const pay = guard(async () => {
    if (checked.error) { setError(checked.error); return; }
    if (cashClosed) { setNeedRegister('pay'); return; }
    await send();
  });

  const keep = () => showConfirm(
    'Keep as your money?',
    `The shop will not pay back ${rupeesText(remaining)}. This line closes.`,
    guard(async () => {
      setBusy(true);
      setError('');
      try {
        await api.keepOwes(line.id);
        finish(`Kept ${rupeesText(remaining)} as your money.`);
      } catch (err) { fail(err); }
    }),
    { confirmLabel: 'Keep it', cancelLabel: 'Back' },
  );

  const doWriteOff = guard(async () => {
    const why = reason.trim();
    if (!why) { setError('Type why this is written off.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.writeOffOwes(line.id, { reason: why });
      finish(`Written off ${rupeesText(remaining)} owed to ${name}.`);
    } catch (err) { fail(err); }
  });

  if (!line) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>
          {needRegister ? (
            <OpenRegisterForm
              locationId={locationId}
              actionLabel="pay back"
              onClose={onClose}
              onOpened={() => {
                const then = needRegister;
                setNeedRegister(null);
                setRegisterOpen(true);
                setError('');
                if (then === 'pay') send();
              }}
              onBack={() => setNeedRegister(null)}
              backLabel="Back"
            />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.headRow}>
                <Text style={styles.title}>Pay back {ownLine ? 'yourself' : name}</Text>
                <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
                  <Ionicons name="close" size={26} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.lead}>
                The shop owes {ownLine ? 'you' : name} <Text style={styles.leadAmount}>{rupeesText(remaining)}</Text>
              </Text>

              {!writeOff && (
                <>
                  <Text style={styles.label}>Amount</Text>
                  <View style={[styles.amountBox, !!error && checked.error && styles.inputError]}>
                    <Text style={styles.rupee}>₹</Text>
                    <TextInput
                      style={styles.amountInput}
                      keyboardType="decimal-pad"
                      value={amount}
                      onChangeText={(t) => { setAmount(t.replace(/[^0-9.]/g, '')); setError(''); }}
                      selectTextOnFocus
                      accessibilityLabel="Amount to pay back in rupees"
                    />
                  </View>
                  {!checked.error && checked.amount < remaining && (
                    <Text style={styles.hint}>Part of it now; the rest stays on the card.</Text>
                  )}

                  <Text style={styles.label}>Paid by</Text>
                  <MethodSwitch value={method} options={METHODS} onChange={(k) => { setMethod(k); setError(''); }} />
                  {cashClosed && (
                    <View style={styles.closedRow}>
                      <Text style={styles.closedText}>{CLOSED_COPY}</Text>
                      <TouchableOpacity style={styles.openRegBtn} onPress={() => setNeedRegister('open')} accessibilityRole="button">
                        <Ionicons name="lock-open-outline" size={18} color={Colors.primary} />
                        <Text style={styles.openRegText}>Open Register</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {!!error && <Text style={styles.error}>{error}</Text>}

                  <TouchableOpacity
                    onPress={pay}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                    style={[styles.primary, (busy || !!checked.error) && styles.primaryOff]}
                  >
                    {busy
                      ? <ActivityIndicator color={Colors.white} />
                      : <Text style={styles.primaryText}>{checked.error ? 'Pay back' : `Pay back ${rupeesText(checked.amount)}`}</Text>}
                  </TouchableOpacity>

                  {isOwner && ownLine && (
                    <TouchableOpacity style={styles.secondary} onPress={keep} disabled={busy} accessibilityRole="button">
                      <Text style={styles.secondaryText}>Keep as my money</Text>
                    </TouchableOpacity>
                  )}
                  {isOwner && (
                    <TouchableOpacity style={styles.linkRow} onPress={() => { setWriteOff(true); setError(''); }} disabled={busy} accessibilityRole="button">
                      <Text style={styles.linkText}>Write off</Text>
                      <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </>
              )}

              {writeOff && (
                <>
                  <Text style={styles.hint}>The shop will not pay back {rupeesText(remaining)}. The drawer does not change.</Text>
                  <Text style={styles.label}>Why?</Text>
                  <TextInput
                    style={[styles.input, !!error && styles.inputError]}
                    value={reason}
                    onChangeText={(t) => { setReason(t); setError(''); }}
                    placeholder="Like: settled outside the shop"
                    placeholderTextColor={Colors.textLight}
                    maxLength={300}
                    accessibilityLabel="Why it is written off"
                  />
                  {!!error && <Text style={styles.error}>{error}</Text>}
                  <TouchableOpacity style={styles.danger} onPress={doWriteOff} disabled={busy} accessibilityRole="button">
                    {busy ? <ActivityIndicator color={Colors.error} /> : <Text style={styles.dangerText}>Write off {rupeesText(remaining)}</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.linkRow} onPress={() => { setWriteOff(false); setError(''); }} disabled={busy} accessibilityRole="button">
                    <Ionicons name="arrow-back" size={18} color={Colors.textSecondary} />
                    <Text style={styles.linkText}>Back to Pay back</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '90%',
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  lead: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  leadAmount: { fontWeight: '800', color: Colors.text },
  label: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  amountBox: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
  },
  rupee: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.textSecondary, marginRight: Spacing.xs },
  amountInput: { flex: 1, fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'], minHeight: 54 },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text,
  },
  inputError: { borderColor: Colors.error },
  hint: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.sm },
  closedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  closedText: { flex: 1, minWidth: 180, fontSize: FontSize.md, color: Colors.text },
  openRegBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  openRegText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.sm },
  primary: {
    marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
  },
  primaryOff: { opacity: 0.5 },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800', textAlign: 'center' },
  secondary: {
    marginTop: Spacing.sm, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
  },
  secondaryText: { color: Colors.text, fontSize: FontSize.md, fontWeight: '700' },
  linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs, minHeight: 48, marginTop: Spacing.xs },
  linkText: { color: Colors.textSecondary, fontSize: FontSize.md, fontWeight: '600' },
  danger: {
    marginTop: Spacing.md, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.error, paddingHorizontal: Spacing.md,
  },
  dangerText: { color: Colors.error, fontSize: FontSize.md, fontWeight: '800' },
});
