/**
 * GiveFloatSheet — change money from the register to a helper (bag mode,
 * spec §11.3): pick helper → amount (filled in with the last float, or 500)
 * → Give. With one helper (or opened from a helper's row) the helper is
 * already picked, so it is: open → Give.
 *
 * Register closed → OpenRegisterForm first, then the float is given.
 *
 * Props: visible, locationId, helpers [{ staff_id, name, last_float }],
 *        initialStaffId, onClose(), onDone({ message, staff_id, amount })
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { parseMoney, cleanMoneyInput, floatDefault, rupees } from '../../utils/helperCash';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const NET_ERROR = 'Nothing was given. Check the internet and tap Give again.';
const isRegisterClosedError = (err) => err && err.status === 400 && /register isn.t open/i.test(err.message || '');

export default function GiveFloatSheet({ visible, locationId, helpers, initialStaffId, onClose, onDone }) {
  const list = Array.isArray(helpers) ? helpers : [];
  const [staffId, setStaffId] = useState(null);
  const [amount, setAmount] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needRegister, setNeedRegister] = useState(false);
  const guard = useSubmitGuard();

  const pick = (id, keepTyped = false) => {
    setStaffId(id);
    if (!keepTyped) {
      const h = list.find((x) => x.staff_id === id);
      setAmount(floatDefault(h ? h.last_float : null));
    }
    setError('');
  };

  useEffect(() => {
    if (!visible) return;
    const first = initialStaffId != null ? initialStaffId : (list.length === 1 ? list[0].staff_id : null);
    setEdited(false);
    setBusy(false);
    setError('');
    setNeedRegister(false);
    if (first != null) pick(first);
    else { setStaffId(null); setAmount(floatDefault(null)); }
  }, [visible, initialStaffId]);

  const helper = list.find((h) => h.staff_id === staffId) || null;
  const value = parseMoney(amount);
  const ready = !!helper && value != null && value > 0;

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.giveHelperFloat({ staff_id: helper.staff_id, location_id: locationId, amount: value });
      setBusy(false);
      onDone && onDone({ message: res.message || `Gave ${rupees(value)} to ${helper.name}.`, staff_id: helper.staff_id, amount: value });
      onClose && onClose();
    } catch (err) {
      setBusy(false);
      if (isRegisterClosedError(err)) { setNeedRegister(true); return; }
      setError(err && err.status ? err.message : NET_ERROR);
    }
  };

  const give = guard(async () => {
    if (!helper) { setError('Tap the helper you are giving change to.'); return; }
    if (!ready) { setError('Type an amount above ₹0, like 500.'); return; }
    let open = true;
    try { open = (await api.getRegisterStatus(locationId)).isOpen === true; } catch { open = true; /* the server checks again */ }
    if (!open) { setNeedRegister(true); return; }
    await send();
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>
          {needRegister ? (
            <OpenRegisterForm
              locationId={locationId}
              actionLabel="give the change"
              onClose={onClose}
              onOpened={() => { setNeedRegister(false); send(); }}
              onBack={() => setNeedRegister(false)}
              backLabel="Back"
            />
          ) : (
            <>
              <View style={styles.headRow}>
                <Text style={styles.title}>Give change to a helper</Text>
                <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
                  <Ionicons name="close" size={26} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.lead}>Takes the money out of the register and adds it to the helper's cash.</Text>

              {list.length > 1 || (list.length === 1 && !helper) ? (
                <>
                  <Text style={styles.label}>Who gets it?</Text>
                  <ScrollView horizontal={false} style={{ maxHeight: 200 }} contentContainerStyle={styles.chips}>
                    {list.map((h) => {
                      const on = h.staff_id === staffId;
                      return (
                        <TouchableOpacity
                          key={h.staff_id}
                          onPress={() => pick(h.staff_id, edited)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on }}
                          style={[styles.chip, on && styles.chipOn]}
                        >
                          <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? Colors.white : Colors.textSecondary} />
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>{h.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </>
              ) : helper ? (
                <Text style={styles.who}>To {helper.name}</Text>
              ) : (
                <Text style={styles.lead}>No helper can take change here right now. The owner or a manager adds helpers in Staff.</Text>
              )}

              <Text style={styles.label}>Amount (₹)</Text>
              <TextInput
                style={[styles.input, !!error && { borderColor: Colors.error }]}
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={(t) => { setAmount(cleanMoneyInput(t)); setEdited(true); setError(''); }}
                onSubmitEditing={give}
                selectTextOnFocus
                accessibilityLabel="Amount of change to give"
              />
              {!!error && <Text style={styles.error}>{error}</Text>}

              <TouchableOpacity
                onPress={give}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || !ready }}
                style={[styles.primary, !ready && styles.primaryOff]}
              >
                {busy
                  ? <ActivityIndicator color={Colors.white} />
                  : <Text style={styles.primaryText}>{ready ? `Give ${rupees(value)} to ${helper.name}` : 'Give'}</Text>}
              </TouchableOpacity>
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
  lead: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs, lineHeight: 22 },
  who: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  chipTextOn: { color: Colors.white },
  input: {
    minHeight: 56, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
    fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'],
  },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  primary: {
    marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.success, paddingHorizontal: Spacing.md,
  },
  primaryOff: { backgroundColor: Colors.border },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800', textAlign: 'center' },
});
