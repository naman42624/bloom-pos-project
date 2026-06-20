import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, ScrollView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function AddPaymentScreen({ route, navigation }) {
  const { saleId, due } = route.params;
  const [payments, setPayments] = useState([{ method: 'cash', amount: String(due || 0), reference_number: '' }]);
  const [writeOffAmount, setWriteOffAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleAddPayment = () => {
    setPayments([...payments, { method: 'cash', amount: '', reference_number: '' }]);
  };

  const updatePayment = (index, field, value) => {
    const updated = [...payments];
    updated[index][field] = value;
    setPayments(updated);
  };

  const removePayment = (index) => {
    setPayments(payments.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const totalPayments = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const woAmount = parseFloat(writeOffAmount) || 0;
    const totalReduction = totalPayments + woAmount;

    if (totalReduction <= 0 || totalReduction > due + 0.01) {
      Alert.alert('Invalid', `Total amount must be between ₹1 and ₹${Number(due).toFixed(2)}`);
      return;
    }

    setSubmitting(true);
    try {
      const formattedPayments = payments
        .map(p => ({ ...p, amount: parseFloat(p.amount) || 0 }))
        .filter(p => p.amount > 0);

      const res = await api.addPaymentToSale(saleId, {
        payments: formattedPayments,
        write_off_amount: woAmount > 0 ? woAmount : undefined,
      });
      
      if (res.success) {
        Alert.alert('Success', `₹${Number(totalPayments).toFixed(2)} payment recorded`);
        navigation.goBack();
      } else {
        Alert.alert('Error', res.message || 'Failed to add payment');
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong');
    } finally { setSubmitting(false); }
  };

  const totalPayments = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const woAmount = parseFloat(writeOffAmount) || 0;
  const remaining = due - totalPayments - woAmount;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Record Payment</Text>
        <View style={styles.dueRow}>
          <Text style={styles.hint}>Balance due: ₹{Number(due || 0).toFixed(2)}</Text>
          <Text style={[styles.hint, { color: remaining < 0 ? Colors.error : remaining === 0 ? Colors.success : Colors.warning }]}>
            Remaining: ₹{remaining.toFixed(2)}
          </Text>
        </View>

        {payments.map((p, index) => (
          <View key={index} style={styles.paymentBlock}>
            <View style={styles.paymentHeader}>
              <Text style={styles.label}>Payment {index + 1}</Text>
              {payments.length > 1 && (
                <TouchableOpacity onPress={() => removePayment(index)}>
                  <Ionicons name="trash-outline" size={18} color={Colors.error} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.chipRow}>
              {PAYMENT_METHODS.map((m) => (
                <TouchableOpacity
                  key={m.key}
                  style={[styles.chip, p.method === m.key && styles.chipActive]}
                  onPress={() => updatePayment(index, 'method', m.key)}
                >
                  <Ionicons name={m.icon} size={16} color={p.method === m.key ? Colors.white : Colors.textSecondary} />
                  <Text style={[styles.chipText, p.method === m.key && styles.chipTextActive]}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={[styles.input, { marginTop: Spacing.sm }]}
              value={p.amount}
              onChangeText={(val) => updatePayment(index, 'amount', val)}
              keyboardType="numeric"
              placeholder="₹ Amount"
              placeholderTextColor={Colors.textLight}
            />

            {p.method !== 'cash' && (
              <TextInput
                style={[styles.input, { marginTop: Spacing.xs }]}
                value={p.reference_number}
                onChangeText={(val) => updatePayment(index, 'reference_number', val)}
                placeholder="Reference / Transaction ID (Optional)"
                placeholderTextColor={Colors.textLight}
              />
            )}
          </View>
        ))}

        <TouchableOpacity style={styles.addBtn} onPress={handleAddPayment}>
          <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
          <Text style={styles.addBtnText}>Add Split Payment</Text>
        </TouchableOpacity>

        <View style={styles.divider} />

        <Text style={styles.label}>Write-off Amount (Optional)</Text>
        <TextInput
          style={styles.input}
          value={writeOffAmount}
          onChangeText={setWriteOffAmount}
          keyboardType="numeric"
          placeholder="₹ Small discrepancy amount"
          placeholderTextColor={Colors.textLight}
        />

        <TouchableOpacity style={[styles.btn, submitting && { opacity: 0.6 }]} onPress={handleSubmit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={Colors.white} /> : (
            <>
              <Ionicons name="checkmark-circle" size={18} color={Colors.white} />
              <Text style={styles.btnText}>Confirm {totalPayments > 0 ? `₹${totalPayments.toFixed(2)}` : ''}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  dueRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2, marginBottom: Spacing.md },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  paymentBlock: {
    backgroundColor: Colors.background, padding: Spacing.sm,
    borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  paymentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
    fontSize: FontSize.sm, color: Colors.text,
  },
  chipRow: { flexDirection: 'row', gap: Spacing.xs, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    paddingVertical: Spacing.sm, borderWidth: 1, borderColor: Colors.primary + '40',
    borderRadius: BorderRadius.md, borderStyle: 'dashed', backgroundColor: Colors.primary + '10',
    marginBottom: Spacing.md,
  },
  addBtnText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.md },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    backgroundColor: Colors.success, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.lg,
  },
  btnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
