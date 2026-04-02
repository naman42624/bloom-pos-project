import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, ScrollView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const REFUND_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function RefundSaleScreen({ route, navigation }) {
  const { saleId, grandTotal } = route.params;
  const [amount, setAmount] = useState(String(grandTotal || 0));
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);

  const handleRefund = async () => {
    const refundAmt = parseFloat(amount);
    if (!refundAmt || refundAmt <= 0 || refundAmt > grandTotal) {
      Alert.alert('Invalid', `Amount must be between ₹1 and ₹${grandTotal}`);
      return;
    }
    if (!reason.trim()) {
      Alert.alert('Required', 'Please provide a reason for the refund');
      return;
    }

    const doRefund = async () => {
      setSubmitting(true);
      try {
        const res = await api.refundSale(saleId, {
          amount: refundAmt,
          reason: reason.trim(),
          refund_method: method,
        });
        if (res.success) {
          Alert.alert('Refunded', `₹${Number(refundAmt).toFixed(2)} refunded successfully`);
          navigation.goBack();
        } else {
          Alert.alert('Error', res.message || 'Refund failed');
        }
      } catch (err) {
        Alert.alert('Error', err.message || 'Something went wrong');
      } finally { setSubmitting(false); }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Refund ₹${Number(refundAmt).toFixed(2)} via ${method}?`)) doRefund();
    } else {
      Alert.alert('Confirm Refund', `Refund ₹${Number(refundAmt).toFixed(2)} via ${method}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Refund', style: 'destructive', onPress: doRefund },
      ]);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Process Refund</Text>
        <Text style={styles.hint}>Sale total: ₹{Number(grandTotal || 0).toFixed(2)}</Text>

        <Text style={styles.label}>Refund Amount</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
          placeholder="₹ 0.00"
          placeholderTextColor={Colors.textLight}
        />

        <Text style={styles.label}>Reason</Text>
        <TextInput
          style={[styles.input, { minHeight: 80 }]}
          value={reason}
          onChangeText={setReason}
          placeholder="Why is this being refunded?"
          placeholderTextColor={Colors.textLight}
          multiline
        />

        <Text style={styles.label}>Refund Method</Text>
        <View style={styles.chipRow}>
          {REFUND_METHODS.map((m) => (
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

        <TouchableOpacity style={[styles.btn, submitting && { opacity: 0.6 }]} onPress={handleRefund} disabled={submitting}>
          {submitting ? <ActivityIndicator color={Colors.white} /> : (
            <>
              <Ionicons name="return-down-back" size={18} color={Colors.white} />
              <Text style={styles.btnText}>Process Refund</Text>
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
    backgroundColor: Colors.error, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.lg,
  },
  btnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
