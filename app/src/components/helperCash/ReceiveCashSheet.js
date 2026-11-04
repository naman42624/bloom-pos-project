/**
 * ReceiveCashSheet — take a helper's cash back into the register (bag mode,
 * spec §11.3). The count is blind:
 *
 *   1. "Count Raju's cash and type the total" [ 3150 ]   [ Next ]
 *      (Next asks the server for a preview: nothing is saved yet)
 *   2. "Expected ₹3,200 · Counted ₹3,150 · Short ₹50"
 *      "Is this all the cash Raju has?"  [ Yes, settle ]  [ No, part of it ]
 *      (the real handover is sent here, is_final true / false)
 *
 * The expected amount is never on screen before the count is typed. If the
 * register is closed, OpenRegisterForm shows first and the step carries on
 * once it is open. On success the sheet closes and onDone(result) gets the
 * server's committed figures, so the caller can show them without one more tap.
 *
 * Props: visible, helper { staff_id, name }, locationId,
 *        onClose(), onDone(result), onStale()  (bag already collected: refresh)
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { showAlert } from '../../utils/alert';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { parseMoney, cleanMoneyInput, handoverResult, rupees } from '../../utils/helperCash';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const ALREADY_COLLECTED = 'Already collected — refresh';
const NET_ERROR = 'Nothing was saved. Check the internet and tap again.';
const isRegisterClosedError = (err) => err && err.status === 400 && /register isn.t open/i.test(err.message || '');

export default function ReceiveCashSheet({ visible, helper, locationId, onClose, onDone, onStale }) {
  const [step, setStep] = useState('count'); // 'count' | 'register' | 'confirm'
  const [count, setCount] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null); // null | 'next' | 'final' | 'partial'
  const [error, setError] = useState('');
  const afterOpen = useRef(null);
  const guard = useSubmitGuard();

  useEffect(() => {
    if (visible) {
      setStep('count');
      setCount('');
      setPreview(null);
      setBusy(null);
      setError('');
      afterOpen.current = null;
    }
  }, [visible, helper && helper.staff_id]);

  if (!helper) return null;
  const name = helper.name || 'the helper';
  const counted = parseMoney(count);

  const handleError = (err, retry) => {
    if (err && err.status === 409 && (err.message || '').startsWith('Already collected')) {
      showAlert(ALREADY_COLLECTED, `${name}'s cash was already taken in. The list will refresh now.`);
      onStale && onStale();
      onClose && onClose();
      return;
    }
    if (isRegisterClosedError(err)) {
      afterOpen.current = retry;
      setStep('register');
      return;
    }
    setError(err && err.status ? err.message : NET_ERROR);
  };

  const runPreview = async () => {
    setBusy('next');
    setError('');
    try {
      const res = await api.helperHandover({
        staff_id: helper.staff_id, location_id: locationId, counted_amount: counted, is_final: false, preview: true,
      });
      setPreview(res.data);
      setStep('confirm');
    } catch (err) {
      handleError(err, runPreview);
    } finally {
      setBusy(null);
    }
  };

  const next = guard(async () => {
    if (counted == null || counted <= 0) {
      setError('Type the amount you counted, like 3150 or 3150.50.');
      return;
    }
    // Same rule as every cash payment: register first, then carry on.
    let open = true;
    try { open = (await api.getRegisterStatus(locationId)).isOpen === true; } catch { open = true; /* the server checks again */ }
    if (!open) {
      afterOpen.current = runPreview;
      setStep('register');
      return;
    }
    await runPreview();
  });

  const send = async (isFinal) => {
    const res = await api.helperHandover({
      staff_id: helper.staff_id, location_id: locationId, counted_amount: counted, is_final: isFinal, preview: false,
    });
    onDone && onDone({ ...res.data, name });
    onClose && onClose();
  };
  const doCommit = async (isFinal) => {
    setBusy(isFinal ? 'final' : 'partial');
    setError('');
    try {
      await send(isFinal);
    } catch (err) {
      // Register closed: OpenRegisterForm, then the same handover runs again
      // under the same guard and busy state.
      handleError(err, guard(async () => {
        setStep('confirm');
        setBusy(isFinal ? 'final' : 'partial');
        try { await send(isFinal); } catch (e2) { handleError(e2, null); } finally { setBusy(null); }
      }));
    } finally {
      setBusy(null);
    }
  };
  const settleAll = guard(() => doCommit(true));
  const settlePart = guard(() => doCommit(false));

  const figures = preview ? handoverResult(preview.expected, preview.counted) : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>
          {step === 'register' ? (
            <OpenRegisterForm
              locationId={locationId}
              actionLabel="take the cash"
              onClose={onClose}
              onOpened={() => {
                const fn = afterOpen.current;
                afterOpen.current = null;
                setStep(preview ? 'confirm' : 'count');
                if (fn) fn();
              }}
              onBack={() => setStep(preview ? 'confirm' : 'count')}
              backLabel="Back"
            />
          ) : (
            <>
              <View style={styles.headRow}>
                <Text style={styles.title} numberOfLines={2}>Receive cash — {name}</Text>
                <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
                  <Ionicons name="close" size={26} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {step === 'count' ? (
                <>
                  <Text style={styles.lead}>Count {name}'s cash and type the total</Text>
                  <Text style={styles.label}>Cash counted (₹)</Text>
                  <TextInput
                    style={[styles.input, !!error && { borderColor: Colors.error }]}
                    keyboardType="decimal-pad"
                    value={count}
                    onChangeText={(t) => { setCount(cleanMoneyInput(t)); setError(''); }}
                    onSubmitEditing={next}
                    placeholder="e.g. 3150"
                    placeholderTextColor={Colors.textLight}
                    autoFocus
                    accessibilityLabel={`Cash counted from ${name}`}
                  />
                  {!!error && <Text style={styles.error}>{error}</Text>}
                  <TouchableOpacity
                    onPress={next}
                    disabled={!!busy}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !!busy || counted == null || counted <= 0 }}
                    style={[styles.primary, (counted == null || counted <= 0) && styles.primaryOff]}
                  >
                    {busy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Next</Text>}
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <View style={[styles.result, figures.kind === 'short' && styles.resultShort, figures.kind === 'over' && styles.resultOver]}>
                    <Text style={styles.resultLine}>
                      Expected {rupees(preview.expected)} · Counted {rupees(preview.counted)} ·{' '}
                      <Text style={styles.resultLabel}>{figures.label}</Text>
                    </Text>
                  </View>
                  <Text style={styles.question}>Is this all the cash {name} has?</Text>
                  {!!error && <Text style={styles.error}>{error}</Text>}
                  <TouchableOpacity
                    onPress={settleAll}
                    disabled={!!busy}
                    accessibilityRole="button"
                    style={styles.primary}
                  >
                    {busy === 'final' ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Yes, settle</Text>}
                  </TouchableOpacity>
                  <Text style={styles.hint}>
                    {figures.kind === 'short'
                      ? `The ${figures.label.toLowerCase()} is recorded against ${name}.`
                      : figures.kind === 'over' ? 'The extra is recorded too.' : `${name}'s bag goes to ₹0.`}
                  </Text>
                  {figures.canPartial ? (
                    <TouchableOpacity
                      onPress={settlePart}
                      disabled={!!busy}
                      accessibilityRole="button"
                      style={styles.secondary}
                    >
                      {busy === 'partial' ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.secondaryText}>No, part of it</Text>}
                    </TouchableOpacity>
                  ) : null}
                  {figures.canPartial && figures.remainingIfPartial > 0 ? (
                    <Text style={styles.hint}>{rupees(figures.remainingIfPartial)} stays with {name} for later.</Text>
                  ) : null}
                  <TouchableOpacity
                    onPress={() => { setStep('count'); setPreview(null); setError(''); }}
                    disabled={!!busy}
                    accessibilityRole="button"
                    style={styles.link}
                  >
                    <Text style={styles.linkText}>Count again</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
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
    padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center',
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  lead: { fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs, lineHeight: 22 },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    minHeight: 56, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
    fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'],
  },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  primary: {
    marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.success,
  },
  primaryOff: { backgroundColor: Colors.border },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  secondary: {
    marginTop: Spacing.md, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  secondaryText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  result: {
    marginTop: Spacing.md, padding: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.successLight, borderWidth: 1, borderColor: Colors.success,
  },
  resultShort: { backgroundColor: Colors.errorLight, borderColor: Colors.error },
  resultOver: { backgroundColor: Colors.warningLight, borderColor: Colors.warning },
  resultLine: { fontSize: FontSize.lg, color: Colors.text, lineHeight: 28, fontVariant: ['tabular-nums'] },
  resultLabel: { fontWeight: '800' },
  question: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs, textAlign: 'center' },
  link: { marginTop: Spacing.sm, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  linkText: { color: Colors.textSecondary, fontSize: FontSize.md, fontWeight: '600' },
});
