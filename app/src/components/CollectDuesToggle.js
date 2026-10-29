/**
 * CollectDuesToggle — "Collect ₹X now too" switch + amount field, shown under
 * the "Previous Dues Pending" line at checkout. Controlled by the parent:
 *   value = { enabled: boolean, amount: string }
 * Off by default. Amount pre-fills with the full dues when switched on.
 */
import React from 'react';
import { View, Text, Switch, TextInput } from 'react-native';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export const EMPTY_DUES = { enabled: false, amount: '' };

// Returns a plain-language error, or '' when the amount is fine (or the toggle is off).
export function duesAmountError(dueAmount, value) {
  if (!value || !value.enabled) return '';
  const due = Number(dueAmount) || 0;
  const amt = parseFloat(value.amount);
  if (!amt || amt < 1) return 'Enter an amount of at least ₹1.';
  if (amt > due + 0.001) return `Enter ${due.toFixed(2).replace(/\.00$/, '')} or less - that is all this customer owes.`;
  return '';
}

export default function CollectDuesToggle({ dueAmount, value, onChange }) {
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
          onValueChange={(on) => onChange({ enabled: on, amount: on ? (value?.amount || dueText) : (value?.amount || '') })}
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
            onChangeText={(t) => onChange({ enabled: true, amount: t.replace(/[^0-9.]/g, '') })}
            accessibilityLabel="Amount of dues to collect"
          />
          {!!error && (
            <Text style={{ color: Colors.error, fontSize: FontSize.sm, marginTop: 4 }}>{error}</Text>
          )}
          <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4 }}>
            Paid the same way as this order.
          </Text>
        </View>
      )}
    </View>
  );
}
