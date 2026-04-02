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
  const [amount, setAmount] = useState(String(due || 0));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || amt > due) {
      Alert.alert('Invalid', `Amount must be between ₹1 and ₹${Number(due).toFixed(2)}`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.addPaymentToSale(saleId, {
        method,
        amount: amt,
        reference_number: reference || null,
      });
      if (res.success) {
        Alert.alert('Success', `₹${Number(amt).toFixed(2)} payment recorded`);
        navigation.goBack();
      } else {
        Alert.alert('Error', res.message || 'Failed to add payment');
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong');
    } finally { setSubmitting(false); }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Record Payment</Text>
        <Text style={styles.hint}>Balance due: ₹{Number(due || 0).toFixed(2)}</Text>

        <Text style={styles.label}>Amount</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
          placeholder="₹ 0.00"
          placeholderTextColor={Colors.textLight}
        />

        <Text style={styles.label}>Payment Method</Text>
        <View style={styles.chipRow}>
          {PAYMENT_METHODS.map((m) => (
            <TouchableOpacity
              key={m.key}
              style={[styles.chip, method === m.key && styles.chipActive]}
              onPress={() => setMethod(m.key)}
            >
              <Ionicons name={m.icon} size={16} color={method === m.key ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, method === m.key && styles.chipTextActive]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {method !== 'cash' && (
          <>
            <Text style={styles.label}>Reference / Transaction ID</Text>
            <TextInput
              style={styles.input}
              value={reference}
              onChangeText={setReference}
              placeholder="Optional"
              placeholderTextColor={Colors.textLight}
            />
          </>
        )}

        <TouchableOpacity style={[styles.btn, submitting && { opacity: 0.6 }]} onPress={handleSubmit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={Colors.white} /> : (
            <>
              <Ionicons name="checkmark-circle" size={18} color={Colors.white} />
              <Text style={styles.btnText}>Record Payment</Text>
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
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
    fontSize: FontSize.sm, color: Colors.text,
  },
  chipRow: { flexDirection: 'row', gap: Spacing.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    backgroundColor: Colors.success, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.lg,
  },
  btnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
