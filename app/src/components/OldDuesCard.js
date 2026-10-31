/**
 * OldDuesCard — the one place a customer's old dues show on Quick Checkout
 * and Log Order. It replaces the red "dues pending" line, the "dues only"
 * button and the "Collect now too" switch.
 *
 *   Not added yet:  "⚠ Old dues ₹1,700   [Collect old dues]"
 *   Added to order: "✓ ₹1,700 old dues will be taken with this order (Cash)
 *                    Change · Remove"
 *
 * The button opens CollectDuesSheet, where staff pick the amount, Cash/UPI
 * and (when there is an order) "Together with this order" or "Only the dues,
 * now". The screen keeps the added dues as
 *   value = { enabled: boolean, amount: string, method: 'cash' | 'upi' }
 */
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export const EMPTY_DUES = { enabled: false, amount: '', method: 'cash' };

const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

// Returns a plain-language error, or '' when the amount is fine (or nothing is added).
export function duesAmountError(dueAmount, value) {
  if (!value || !value.enabled) return '';
  const due = Number(dueAmount) || 0;
  const amt = parseFloat(value.amount);
  if (!amt || amt < 1) return 'Enter an amount of at least ₹1.';
  if (amt > due + 0.001) return `Enter ${money(due)} or less - that is all this customer owes.`;
  return '';
}

export default function OldDuesCard({ dueAmount, value, onCollect, onRemove }) {
  const due = Number(dueAmount) || 0;
  if (due <= 0) return null;
  const added = !!value?.enabled;

  if (added) {
    const amt = parseFloat(value.amount) || 0;
    return (
      <View style={{
        marginTop: 6, padding: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1,
        borderColor: Colors.success, backgroundColor: Colors.success + '12',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
          <Ionicons name="checkmark-circle" size={22} color={Colors.success} />
          <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>
            ₹{money(amt)} old dues will be taken with this order ({value.method === 'upi' ? 'UPI' : 'Cash'})
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
          <TouchableOpacity onPress={onCollect} accessibilityRole="button" style={linkBtn}>
            <Text style={linkText}>Change</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onRemove} accessibilityRole="button" style={linkBtn}>
            <Text style={[linkText, { color: Colors.error }]}>Remove</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={{
      marginTop: 6, padding: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1,
      borderColor: Colors.error + '40', backgroundColor: Colors.error + '0D',
      flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm,
    }}>
      <Ionicons name="alert-circle" size={22} color={Colors.error} />
      <View style={{ flex: 1, minWidth: 140 }}>
        <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.error }}>Old dues ₹{money(due)}</Text>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>From earlier orders</Text>
      </View>
      <TouchableOpacity
        onPress={onCollect}
        accessibilityRole="button"
        accessibilityLabel={`Collect old dues of ${money(due)} rupees`}
        style={{
          minHeight: 48, paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.md,
          backgroundColor: Colors.success, flexDirection: 'row', alignItems: 'center', gap: 6,
        }}
      >
        <Ionicons name="wallet-outline" size={18} color={Colors.white} />
        <Text style={{ color: Colors.white, fontSize: FontSize.md, fontWeight: '800' }}>Collect old dues</Text>
      </TouchableOpacity>
    </View>
  );
}

const linkBtn = {
  minHeight: 44, paddingHorizontal: Spacing.md, justifyContent: 'center',
  borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
};
const linkText = { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary };
