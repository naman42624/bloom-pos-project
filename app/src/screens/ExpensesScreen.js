import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Alert, ScrollView, Modal, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const EXPENSE_CATEGORIES = [
  { key: 'supplies', label: 'Supplies', icon: 'cart' },
  { key: 'petty_cash', label: 'Petty Cash', icon: 'cash' },
  { key: 'maintenance', label: 'Maintenance', icon: 'construct' },
  { key: 'transport', label: 'Transport', icon: 'car' },
  { key: 'food', label: 'Food', icon: 'fast-food' },
  { key: 'utilities', label: 'Utilities', icon: 'flash' },
  { key: 'salary', label: 'Salary', icon: 'people' },
  { key: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function ExpensesScreen() {
  const [expenses, setExpenses] = useState([]);
  const [total, setTotal] = useState(0);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [loading, setLoading] = useState(true);

  // Add modal
  const [showAdd, setShowAdd] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('petty_cash');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      if (selectedLocation) fetchExpenses();
    }, [selectedLocation])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch {}
  };

  const fetchExpenses = async () => {
    try {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);
      const res = await api.getExpenses({ location_id: selectedLocation, start_date: today, end_date: today });
      setExpenses(res.data || []);
      setTotal(res.total || 0);
    } catch {} finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    const amt = parseFloat(amount) || 0;
    if (amt <= 0) { Alert.alert('Invalid', 'Enter a valid amount'); return; }
    if (!description.trim()) { Alert.alert('Required', 'Enter a description'); return; }

    setSubmitting(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await api.createExpense({
        location_id: selectedLocation,
        category,
        amount: amt,
        description: description.trim(),
        payment_method: paymentMethod,
        expense_date: today,
      });
      setShowAdd(false);
      setAmount(''); setDescription(''); setCategory('petty_cash'); setPaymentMethod('cash');
      fetchExpenses();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add expense');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (expense) => {
    Alert.alert('Delete Expense', `Delete ₹${expense.amount.toFixed(0)} — ${expense.description}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteExpense(expense.id);
            fetchExpenses();
          } catch (err) {
            Alert.alert('Error', err.message || 'Failed to delete');
          }
        },
      },
    ]);
  };

  const getCatIcon = (cat) => {
    const found = EXPENSE_CATEGORIES.find((c) => c.key === cat);
    return found ? found.icon : 'ellipsis-horizontal';
  };

  const getCatLabel = (cat) => {
    const found = EXPENSE_CATEGORIES.find((c) => c.key === cat);
    return found ? found.label : cat;
  };

  const renderExpense = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardIcon}>
        <Ionicons name={getCatIcon(item.category)} size={22} color={Colors.primary} />
      </View>
      <View style={styles.cardCenter}>
        <Text style={styles.cardDesc} numberOfLines={1}>{item.description}</Text>
        <Text style={styles.cardMeta}>
          {getCatLabel(item.category)} • {item.payment_method.toUpperCase()} • {item.created_by_name}
        </Text>
      </View>
      <View style={styles.cardRight}>
        <Text style={styles.cardAmount}>₹{item.amount.toFixed(0)}</Text>
        <TouchableOpacity onPress={() => handleDelete(item)}>
          <Ionicons name="trash-outline" size={16} color={Colors.error} />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Location selector */}
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow} contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs }}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Today's total */}
      <View style={styles.summaryCard}>
        <Ionicons name="wallet" size={24} color={Colors.primary} />
        <View style={{ flex: 1, marginLeft: Spacing.sm }}>
          <Text style={styles.summaryLabel}>Today's Expenses</Text>
          <Text style={styles.summaryAmount}>₹{total.toFixed(0)}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(true)}>
          <Ionicons name="add" size={22} color={Colors.white} />
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={expenses}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderExpense}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No expenses today'}</Text>
          </View>
        }
      />

      {/* Add Expense Modal */}
      <Modal visible={showAdd} transparent animationType="slide">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Add Expense</Text>
                <TouchableOpacity onPress={() => setShowAdd(false)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={styles.fieldLabel}>Amount (₹) *</Text>
                <TextInput
                  style={styles.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                  autoFocus
                />

                <Text style={styles.fieldLabel}>Description *</Text>
                <TextInput
                  style={styles.input}
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What was this expense for?"
                  placeholderTextColor={Colors.textLight}
                />

                <Text style={styles.fieldLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs, paddingBottom: Spacing.xs }}>
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat.key}
                      style={[styles.chip, category === cat.key && styles.chipActive]}
                      onPress={() => setCategory(cat.key)}
                    >
                      <Ionicons name={cat.icon} size={14} color={category === cat.key ? Colors.white : Colors.textSecondary} />
                      <Text style={[styles.chipText, category === cat.key && styles.chipTextActive]}>{cat.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <Text style={styles.fieldLabel}>Payment Method</Text>
                <View style={styles.chipRow}>
                  {PAYMENT_METHODS.map((m) => (
                    <TouchableOpacity
                      key={m.key}
                      style={[styles.chip, paymentMethod === m.key && styles.chipActive]}
                      onPress={() => setPaymentMethod(m.key)}
                    >
                      <Ionicons name={m.icon} size={14} color={paymentMethod === m.key ? Colors.white : Colors.textSecondary} />
                      <Text style={[styles.chipText, paymentMethod === m.key && styles.chipTextActive]}>{m.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                  onPress={handleAdd}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Ionicons name="add-circle" size={18} color={Colors.white} />
                      <Text style={styles.submitBtnText}>Add Expense</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  locRow: { maxHeight: 44, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  locChipTextActive: { color: Colors.white, fontWeight: '600' },

  summaryCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, margin: Spacing.md, padding: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textSecondary },
  summaryAmount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
  },
  addBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },

  list: { paddingHorizontal: Spacing.md, paddingBottom: 40 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  cardCenter: { flex: 1 },
  cardDesc: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  cardRight: { alignItems: 'flex-end', gap: Spacing.xs },
  cardAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.error },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  fieldLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.sm, color: Colors.text,
  },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primary, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, marginTop: Spacing.lg, marginBottom: Spacing.md,
  },
  submitBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
