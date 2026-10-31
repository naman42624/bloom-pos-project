/**
 * CollectDuesToggle — "Collect ₹X now too" switch + amount field, shown under
 * the "Previous Dues Pending" line at checkout. Controlled by the parent:
 *   value = { enabled: boolean, amount: string, method?: 'cash' | 'upi' }
 * Off by default. Amount pre-fills with the full dues when switched on.
 * askMethod: the order itself is not being paid now (credit/COD/not paid yet),
 * so staff pick Cash or UPI for the dues here; otherwise the dues are paid the
 * same way as the order.
 */
import React from 'react';
import { View, Text, Switch, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export const EMPTY_DUES = { enabled: false, amount: '', method: 'cash' };

// How the dues are paid: the order's own method when it is paid now,
// otherwise the Cash/UPI choice made on the toggle.
export function duesPaymentMethod(value, orderMethodIfPaidNow) {
  if (orderMethodIfPaidNow) return orderMethodIfPaidNow;
  return value && value.method === 'upi' ? 'upi' : 'cash';
}

const DUES_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash-outline' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait-outline' },
];

// Returns a plain-language error, or '' when the amount is fine (or the toggle is off).
export function duesAmountError(dueAmount, value) {
  if (!value || !value.enabled) return '';
  const due = Number(dueAmount) || 0;
  const amt = parseFloat(value.amount);
  if (!amt || amt < 1) return 'Enter an amount of at least ₹1.';
  if (amt > due + 0.001) return `Enter ${due.toFixed(2).replace(/\.00$/, '')} or less - that is all this customer owes.`;
  return '';
}

export default function CollectDuesToggle({ dueAmount, value, onChange, askMethod = false }) {
  const due = Number(dueAmount) || 0;
  if (due <= 0) return null;
  const dueText = due.toFixed(2).replace(/\.00$/, '');
  const enabled = !!value?.enabled;
  const error = duesAmountError(due, value);

  return (
    <View style={{
      marginTop: 6, padding: Spacing.sm, borderRadius: BorderRadius.md,
      borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 }}>
        <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text }}>
          Collect ₹{dueText} now too
        </Text>
        <Switch
          value={enabled}
          onValueChange={(on) => onChange({ ...value, enabled: on, amount: on ? (value?.amount || dueText) : (value?.amount || '') })}
          trackColor={{ true: Colors.primary }}
          accessibilityLabel={`Collect ${dueText} rupees of previous dues now too`}
        />
      </View>
      {enabled && (
        <View style={{ marginTop: 4 }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: 4 }}>
            Amount of dues to collect (₹)
          </Text>
          <TextInput
            style={{
              minHeight: 48, borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
              fontSize: FontSize.md, color: Colors.text,
              borderColor: error ? Colors.error : Colors.border,
            }}
            keyboardType="numeric"
            value={value?.amount || ''}
            onChangeText={(t) => onChange({ ...value, enabled: true, amount: t.replace(/[^0-9.]/g, '') })}
            accessibilityLabel="Amount of dues to collect"
          />
          {!!error && (
            <Text style={{ color: Colors.error, fontSize: FontSize.sm, marginTop: 4 }}>{error}</Text>
          )}
          {askMethod ? (
            <>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm, marginBottom: 4 }}>
                How are the dues being paid?
              </Text>
              <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                {DUES_METHODS.map((m) => {
                  const on = duesPaymentMethod(value, null) === m.key;
                  return (
                    <TouchableOpacity
                      key={m.key}
                      onPress={() => onChange({ ...value, enabled: true, method: m.key })}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      style={{
                        flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        borderRadius: BorderRadius.md, borderWidth: 1,
                        borderColor: on ? Colors.primary : Colors.border,
                        backgroundColor: on ? Colors.primary : Colors.surface,
                      }}
                    >
                      <Ionicons name={m.icon} size={18} color={on ? Colors.white : Colors.textSecondary} />
                      <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: on ? Colors.white : Colors.text }}>{m.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4 }}>
              Paid the same way as this order.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
