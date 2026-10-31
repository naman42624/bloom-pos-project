/**
 * CollectDuesSheet — the one panel for taking a customer's old dues.
 * Used from the Old dues card on Quick Checkout and Log Order, the customer
 * list's "Collect" button and the dashboard's "Collect dues" list.
 *
 * The amount starts at the full dues; Cash is the default. Cash needs an open
 * register at this location (same rule as every other cash payment), so the
 * register is checked first; if it is closed the panel switches to "Register
 * is closed" (OpenRegisterForm), which opens it and then records the payment.
 *
 * When an order is being made (onAddToOrder given), staff also choose:
 *   "Together with this order" (default) — nothing is recorded yet; the
 *     amount and method go back to the screen and are taken when the order
 *     is placed.
 *   "Only the dues, now" — recorded straight away, like the customer list.
 *
 * Props: visible, customer { id, name, credit_balance }, locationId,
 *        onClose(), onDone({ amount, newBalance }),
 *        onAddToOrder({ amount, method })  (optional),
 *        initial { amount, method }        (optional, when changing an added amount)
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { showAlert } from '../utils/alert';
import { OpenRegisterForm } from './OpenRegisterSheet';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { bumpActivity } from '../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash-outline' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait-outline' },
];

const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

export default function CollectDuesSheet({ visible, customer, locationId, onClose, onDone, onAddToOrder, initial }) {
  const canAddToOrder = typeof onAddToOrder === 'function';
  const due = Number(customer?.credit_balance) || 0;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState('order'); // 'order' | 'now'
  const [needRegister, setNeedRegister] = useState(false);

  useEffect(() => {
    if (visible) {
      setAmount(initial && initial.amount ? String(initial.amount) : money(due));
      setMethod(initial && initial.method === 'upi' ? 'upi' : 'cash');
      setMode(canAddToOrder ? 'order' : 'now');
      setSaving(false);
      setNeedRegister(false);
    }
  }, [visible, customer?.id]);

  const withOrder = canAddToOrder && mode === 'order';

  const amt = Math.round((parseFloat(amount) || 0) * 100) / 100;
  let error = '';
  if (!amt || amt < 1) error = 'Enter an amount of at least ₹1.';
  else if (amt > due + 0.001) error = `Enter ${money(due)} or less - that is all this customer owes.`;

  const guard = useSubmitGuard();
  const submit = guard(async () => {
    if (error || !customer) return;
    if (withOrder) {
      // Taken when the order is placed (register is checked there too).
      onAddToOrder({ amount: amt, method });
      return;
    }
    if (!locationId) {
      showAlert('Choose a shop', 'This device has no shop selected. Pick your shop on the dashboard, then try again.');
      return;
    }
    setSaving(true);
    if (method === 'cash') {
      let open = false;
      try { open = (await api.getRegisterStatus(locationId)).isOpen === true; } catch { open = false; }
      if (!open) {
        setSaving(false);
        setNeedRegister(true);
        return;
      }
    }
    await record();
  });

  const record = async () => {
    setSaving(true);
    try {
      const res = await api.addCreditPayment(customer.id, {
        amount: amt,
        method,
        location_id: locationId,
        notes: 'Dues collected',
      });
      const newBalance = Number(res?.new_balance ?? Math.max(0, due - amt));
      setSaving(false);
      onDone && onDone({ amount: amt, newBalance });
      showAlert('Dues collected', `₹${money(amt)} collected from ${customer.name || 'the customer'}. Balance now ₹${money(newBalance)}.`);
    } catch (err) {
      setSaving(false);
      showAlert('Could not record the payment', err?.message || 'Please check the connection and try again.');
    }
  };

  if (!customer) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View onTouchStart={bumpActivity} style={{
          backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
          padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center',
        }}>
          {needRegister ? (
            <OpenRegisterForm
              locationId={locationId}
              actionLabel={`collect ₹${money(amt)}`}
              onClose={onClose}
              onOpened={() => { setNeedRegister(false); record(); }}
              onBack={() => { setMethod('upi'); setNeedRegister(false); }}
              backLabel="They paid by UPI instead"
            />
          ) : (
          <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 }} numberOfLines={1}>
              Collect dues — {customer.name || 'Customer'}
            </Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
              <Ionicons name="close" size={26} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 2 }}>
            They owe ₹{money(due)}
          </Text>

          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: 4 }}>Amount (₹)</Text>
          <TextInput
            style={{
              minHeight: 52, borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
              fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
              borderColor: error ? Colors.error : Colors.border,
            }}
            keyboardType="numeric"
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
            accessibilityLabel="Amount of dues to collect"
          />
          {!!error && <Text style={{ color: Colors.error, fontSize: FontSize.sm, marginTop: 4 }}>{error}</Text>}

          <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md }}>
            {METHODS.map((m) => {
              const on = method === m.key;
              return (
                <TouchableOpacity
                  key={m.key}
                  onPress={() => setMethod(m.key)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={{
                    flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    borderRadius: BorderRadius.md, borderWidth: 1,
                    borderColor: on ? Colors.primary : Colors.border,
                    backgroundColor: on ? Colors.primary : Colors.surface,
                  }}
                >
                  <Ionicons name={m.icon} size={20} color={on ? Colors.white : Colors.textSecondary} />
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: on ? Colors.white : Colors.text }}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {canAddToOrder && (
            <View style={{ marginTop: Spacing.md, gap: Spacing.sm }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>When?</Text>
              {[
                { key: 'order', label: 'Together with this order', hint: 'Taken when you place the order' },
                { key: 'now', label: 'Only the dues, now', hint: 'Recorded straight away' },
              ].map((o) => {
                const on = mode === o.key;
                return (
                  <TouchableOpacity
                    key={o.key}
                    onPress={() => setMode(o.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={{
                      minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
                      paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: on ? 2 : 1,
                      borderColor: on ? Colors.primary : Colors.border, backgroundColor: on ? Colors.primary + '10' : Colors.surface,
                    }}
                  >
                    <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? Colors.primary : Colors.textSecondary} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{o.label}</Text>
                      <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{o.hint}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <TouchableOpacity
            onPress={submit}
            disabled={!!error || saving}
            accessibilityRole="button"
            style={{
              marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
              backgroundColor: error ? Colors.border : Colors.success,
            }}
          >
            {saving
              ? <ActivityIndicator color={Colors.white} />
              : <Text style={{ color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' }}>
                  {withOrder ? 'Add' : 'Collect'} ₹{error ? money(due) : money(amt)}{method === 'upi' ? ' (UPI)' : ''}{withOrder ? ' to this order' : ''}
                </Text>}
          </TouchableOpacity>
          </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
