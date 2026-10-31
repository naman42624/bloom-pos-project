/**
 * CollectDuesSheet — take a customer's old dues without a new order.
 * One panel used from Quick Checkout ("Collect ₹X dues only"), the customer
 * list's "Collect" button and the dashboard's "Collect dues" list.
 *
 * The amount starts at the full dues; Cash is the default. Cash needs an open
 * register at this location (same rule as every other cash payment), so the
 * register is checked first and staff are offered "Open Register".
 *
 * Props: visible, customer { id, name, credit_balance }, locationId,
 *        onClose(), onDone({ amount, newBalance }), onOpenRegister()
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { showAlert, showConfirm } from '../utils/alert';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { bumpActivity } from '../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash-outline' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait-outline' },
];

const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

export default function CollectDuesSheet({ visible, customer, locationId, onClose, onDone, onOpenRegister }) {
  const due = Number(customer?.credit_balance) || 0;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setAmount(money(due));
      setMethod('cash');
      setSaving(false);
    }
  }, [visible, customer?.id]);

  const amt = Math.round((parseFloat(amount) || 0) * 100) / 100;
  let error = '';
  if (!amt || amt < 1) error = 'Enter an amount of at least ₹1.';
  else if (amt > due + 0.001) error = `Enter ${money(due)} or less - that is all this customer owes.`;

  const guard = useSubmitGuard();
  const submit = guard(async () => {
    if (error || !customer) return;
    if (!locationId) {
      showAlert('Choose a shop', 'This device has no shop selected. Pick your shop on the dashboard, then try again.');
      return;
    }
    setSaving(true);
    try {
      if (method === 'cash') {
        let open = false;
        try { open = (await api.getRegisterStatus(locationId)).isOpen === true; } catch { open = false; }
        if (!open) {
          setSaving(false);
          showConfirm(
            'Register Closed',
            'Open the cash register before taking cash. Or choose UPI if they paid by UPI.',
            () => { onClose && onClose(); onOpenRegister && onOpenRegister(); },
            { confirmLabel: 'Open Register' }
          );
          return;
        }
      }
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
  });

  if (!customer) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View onTouchStart={bumpActivity} style={{
          backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
          padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center',
        }}>
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
                  Collect ₹{error ? money(due) : money(amt)}{method === 'upi' ? ' (UPI)' : ''}
                </Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
