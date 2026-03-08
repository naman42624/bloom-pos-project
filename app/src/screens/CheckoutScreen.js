import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, Platform, ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ORDER_TYPES = [
  { key: 'walk_in', label: 'Walk-in', icon: 'walk' },
  { key: 'pickup', label: 'Pickup', icon: 'bag-handle' },
  { key: 'delivery', label: 'Delivery', icon: 'bicycle' },
  { key: 'pre_order', label: 'Pre-order', icon: 'calendar' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function CheckoutScreen({ route, navigation }) {
  const { cart, locationId } = route.params;
  const { user } = useAuth();

  const [orderType, setOrderType] = useState('walk_in');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [discountType, setDiscountType] = useState('fixed');
  const [discountValue, setDiscountValue] = useState('');
  const [deliveryCharges, setDeliveryCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Customer lookup
  const [customerHistory, setCustomerHistory] = useState(null);

  // Scheduled date/time — for pickup, delivery, and pre-order
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  // Pre-order sub-type (pickup or delivery)
  const [preOrderType, setPreOrderType] = useState('pickup');
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');

  // Split payment — array of payment entries
  const [payments, setPayments] = useState([
    { method: 'cash', amount: '', reference: '' },
  ]);

  const subtotal = cart.reduce((s, c) => s + (c.unit_price * c.quantity), 0);
  const taxTotal = cart.reduce((s, c) => s + ((c.unit_price * c.quantity * c.tax_rate) / 100), 0);

  const discount = useMemo(() => {
    const val = parseFloat(discountValue) || 0;
    if (discountType === 'percentage') return Math.min(subtotal * val / 100, subtotal);
    return Math.min(val, subtotal);
  }, [discountType, discountValue, subtotal]);

  const needsDelivery = orderType === 'delivery' || (orderType === 'pre_order' && preOrderType === 'delivery');
  const delivery = needsDelivery ? (parseFloat(deliveryCharges) || 0) : 0;
  const grandTotal = Math.max(0, subtotal - discount) + taxTotal + delivery;

  const totalPaymentEntered = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  // Auto-fill customer name from phone
  React.useEffect(() => {
    if (customerPhone.length >= 10) {
      (async () => {
        try {
          const res = await api.customerLookup(customerPhone);
          if (res.data) {
            setCustomerHistory(res.data);
            if (!customerName && res.data.customer_name) {
              setCustomerName(res.data.customer_name);
            }
          } else {
            setCustomerHistory(null);
          }
        } catch {
          setCustomerHistory(null);
        }
      })();
    } else {
      setCustomerHistory(null);
    }
  }, [customerPhone]);

  const addPaymentSplit = () => {
    setPayments([...payments, { method: 'card', amount: '', reference: '' }]);
  };

  const removePaymentSplit = (idx) => {
    if (payments.length <= 1) return;
    setPayments(payments.filter((_, i) => i !== idx));
  };

  const updatePayment = (idx, field, value) => {
    setPayments(payments.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const handleSubmit = async () => {
    if (submitting) return;

    if (orderType === 'pre_order' && !scheduledDate) {
      Alert.alert('Required', 'Please enter a scheduled date for pre-order');
      return;
    }
    if (needsDelivery && !deliveryAddress) {
      Alert.alert('Required', 'Please enter a delivery address');
      return;
    }

    // Build payments array
    const advance = parseFloat(advanceAmount) || 0;
    const isPreOrderWithAdvance = orderType === 'pre_order' && advance > 0;

    const paymentEntries = payments.map((p, idx) => ({
      method: p.method,
      amount: isPreOrderWithAdvance && idx === 0
        ? advance
        : (parseFloat(p.amount) || (payments.length === 1 ? grandTotal : 0)),
      reference_number: p.reference || null,
    })).filter(p => p.amount > 0);

    if (paymentEntries.length === 0 && !isPreOrderWithAdvance) {
      Alert.alert('Payment', 'Please enter payment amount');
      return;
    }

    const saleData = {
      location_id: locationId,
      order_type: orderType,
      customer_name: customerName || null,
      customer_phone: customerPhone || null,
      discount_type: discount > 0 ? discountType : null,
      discount_value: discount > 0
        ? (discountType === 'percentage' ? (parseFloat(discountValue) || 0) : discount)
        : 0,
      delivery_charges: delivery,
      notes: notes || null,
      delivery_address: needsDelivery ? deliveryAddress : null,
      scheduled_date: scheduledDate || null,
      scheduled_time: scheduledTime || null,
      items: cart.map((c) => ({
        product_id: c.product_id || null,
        material_id: c.material_id || null,
        product_name: c.product_name,
        product_sku: c.product_sku,
        quantity: c.quantity,
        unit_price: c.unit_price,
        tax_rate: c.tax_rate,
      })),
      payments: paymentEntries,
    };

    if (orderType === 'pre_order') {
      saleData.pre_order = {
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime || null,
        advance_amount: advance,
        remaining_amount: grandTotal - advance,
        delivery_address: needsDelivery ? deliveryAddress : null,
        special_instructions: notes || null,
      };
      saleData.advance_amount = advance;
    }

    setSubmitting(true);
    try {
      const res = await api.createSale(saleData);
      if (res.success) {
        navigation.replace('SaleDetail', { saleId: res.data.id });
      } else {
        Alert.alert('Error', res.message || 'Failed to create sale');
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const showScheduledFields = orderType === 'pickup' || orderType === 'delivery' || orderType === 'pre_order';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Order Type */}
        <Text style={styles.sectionTitle}>Order Type</Text>
        <View style={styles.chipRow}>
          {ORDER_TYPES.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.chip, orderType === t.key && styles.chipActive]}
              onPress={() => setOrderType(t.key)}
            >
              <Ionicons name={t.icon} size={16} color={orderType === t.key ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, orderType === t.key && styles.chipTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Pre-order sub-type */}
        {orderType === 'pre_order' && (
          <>
            <Text style={styles.sectionTitle}>Pre-order Type</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.chip, preOrderType === 'pickup' && styles.chipActive]}
                onPress={() => setPreOrderType('pickup')}
              >
                <Ionicons name="bag-handle" size={16} color={preOrderType === 'pickup' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.chipText, preOrderType === 'pickup' && styles.chipTextActive]}>Pickup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.chip, preOrderType === 'delivery' && styles.chipActive]}
                onPress={() => setPreOrderType('delivery')}
              >
                <Ionicons name="bicycle" size={16} color={preOrderType === 'delivery' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.chipText, preOrderType === 'delivery' && styles.chipTextActive]}>Delivery</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Customer info */}
        <Text style={styles.sectionTitle}>Customer (optional)</Text>
        <View style={styles.row}>
          <TextInput style={[styles.input, { flex: 1 }]} value={customerName} onChangeText={setCustomerName} placeholder="Name" placeholderTextColor={Colors.textLight} />
          <TextInput style={[styles.input, { flex: 1 }]} value={customerPhone} onChangeText={setCustomerPhone} placeholder="Phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
        </View>
        {customerHistory && (
          <View style={styles.customerHint}>
            <Ionicons name="person-circle" size={16} color={Colors.primary} />
            <Text style={styles.customerHintText}>
              Returning customer • {customerHistory.order_count} orders • ₹{(customerHistory.total_spent || 0).toFixed(0)} total
            </Text>
          </View>
        )}

        {/* Scheduled date/time — for pickup, delivery, pre-order */}
        {showScheduledFields && (
          <>
            <Text style={styles.sectionTitle}>
              {orderType === 'pre_order' ? 'Scheduled Date & Time' : 'Scheduled For (optional)'}
            </Text>
            <View style={styles.row}>
              <TextInput style={[styles.input, { flex: 1 }]} value={scheduledDate} onChangeText={setScheduledDate} placeholder="Date (YYYY-MM-DD)" placeholderTextColor={Colors.textLight} />
              <TextInput style={[styles.input, { flex: 1 }]} value={scheduledTime} onChangeText={setScheduledTime} placeholder="Time (e.g. 14:00)" placeholderTextColor={Colors.textLight} />
            </View>
          </>
        )}

        {/* Delivery address */}
        {needsDelivery && (
          <>
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <TextInput style={styles.input} value={deliveryAddress} onChangeText={setDeliveryAddress} placeholder="Full address" placeholderTextColor={Colors.textLight} multiline />
          </>
        )}

        {/* Pre-order advance */}
        {orderType === 'pre_order' && (
          <>
            <Text style={styles.sectionTitle}>Advance Payment</Text>
            <TextInput style={styles.input} value={advanceAmount} onChangeText={setAdvanceAmount} placeholder="₹ Advance amount" placeholderTextColor={Colors.textLight} keyboardType="numeric" />
            {parseFloat(advanceAmount) > 0 && (
              <Text style={styles.remainingHint}>
                Remaining: ₹{(grandTotal - (parseFloat(advanceAmount) || 0)).toFixed(2)}
              </Text>
            )}
          </>
        )}

        {/* Discount */}
        <Text style={styles.sectionTitle}>Discount</Text>
        <View style={styles.row}>
          <View style={styles.discountToggle}>
            <TouchableOpacity
              style={[styles.discToggleBtn, discountType === 'fixed' && styles.discToggleBtnActive]}
              onPress={() => setDiscountType('fixed')}
            >
              <Text style={[styles.discToggleText, discountType === 'fixed' && styles.discToggleTextActive]}>₹</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.discToggleBtn, discountType === 'percentage' && styles.discToggleBtnActive]}
              onPress={() => setDiscountType('percentage')}
            >
              <Text style={[styles.discToggleText, discountType === 'percentage' && styles.discToggleTextActive]}>%</Text>
            </TouchableOpacity>
          </View>
          <TextInput style={[styles.input, { flex: 1 }]} value={discountValue} onChangeText={setDiscountValue}
            placeholder={discountType === 'percentage' ? 'Percentage' : 'Amount'} placeholderTextColor={Colors.textLight} keyboardType="numeric" />
        </View>

        {/* Delivery charges */}
        {needsDelivery && (
          <>
            <Text style={styles.sectionTitle}>Delivery Charges</Text>
            <TextInput style={styles.input} value={deliveryCharges} onChangeText={setDeliveryCharges}
              placeholder="₹ 0" placeholderTextColor={Colors.textLight} keyboardType="numeric" />
          </>
        )}

        {/* Notes */}
        <Text style={styles.sectionTitle}>Notes</Text>
        <TextInput style={[styles.input, { minHeight: 60 }]} value={notes} onChangeText={setNotes}
          placeholder="Any special instructions..." placeholderTextColor={Colors.textLight} multiline />

        {/* Order summary */}
        <View style={styles.summaryBox}>
          <Text style={styles.summaryTitle}>Order Summary</Text>
          {cart.map((c, idx) => (
            <View key={c.material_id ? `mat_${c.material_id}` : `prod_${c.product_id}`} style={styles.summaryRow}>
              <Text style={styles.summaryItemName} numberOfLines={1}>{c.material_id ? '🌿 ' : ''}{c.product_name} x {c.quantity}</Text>
              <Text style={styles.summaryItemPrice}>₹{(c.unit_price * c.quantity).toFixed(2)}</Text>
            </View>
          ))}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tax</Text>
            <Text style={styles.summaryValue}>₹{taxTotal.toFixed(2)}</Text>
          </View>
          {discount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: Colors.error }]}>Discount</Text>
              <Text style={[styles.summaryValue, { color: Colors.error }]}>-₹{discount.toFixed(2)}</Text>
            </View>
          )}
          {delivery > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Delivery</Text>
              <Text style={styles.summaryValue}>₹{delivery.toFixed(2)}</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.grandLabel}>Grand Total</Text>
            <Text style={styles.grandValue}>₹{grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        {/* Payment — split payment support */}
        <View style={styles.paymentSection}>
          <View style={styles.paymentHeader}>
            <Text style={styles.sectionTitle}>Payment</Text>
            <TouchableOpacity onPress={addPaymentSplit} style={styles.splitBtn}>
              <Ionicons name="add-circle" size={16} color={Colors.primary} />
              <Text style={styles.splitBtnText}>Split</Text>
            </TouchableOpacity>
          </View>

          {payments.map((pmt, idx) => (
            <View key={idx} style={styles.paymentEntry}>
              {payments.length > 1 && (
                <View style={styles.paymentEntryHeader}>
                  <Text style={styles.paymentEntryLabel}>Payment {idx + 1}</Text>
                  <TouchableOpacity onPress={() => removePaymentSplit(idx)}>
                    <Ionicons name="close-circle" size={18} color={Colors.error} />
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.chipRow}>
                {PAYMENT_METHODS.map((m) => (
                  <TouchableOpacity
                    key={m.key}
                    style={[styles.chip, pmt.method === m.key && styles.chipActive]}
                    onPress={() => updatePayment(idx, 'method', m.key)}
                  >
                    <Ionicons name={m.icon} size={14} color={pmt.method === m.key ? Colors.white : Colors.textSecondary} />
                    <Text style={[styles.chipText, pmt.method === m.key && styles.chipTextActive]}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {payments.length > 1 && (
                <TextInput
                  style={styles.input}
                  value={pmt.amount}
                  onChangeText={(v) => updatePayment(idx, 'amount', v)}
                  placeholder="₹ Amount"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
              )}
              {pmt.method !== 'cash' && (
                <TextInput
                  style={styles.input}
                  value={pmt.reference}
                  onChangeText={(v) => updatePayment(idx, 'reference', v)}
                  placeholder="Reference / Transaction ID"
                  placeholderTextColor={Colors.textLight}
                />
              )}
            </View>
          ))}

          {payments.length > 1 && (
            <View style={[styles.summaryRow, { marginTop: Spacing.xs }]}>
              <Text style={styles.summaryLabel}>Total Entered</Text>
              <Text style={[styles.summaryValue, {
                color: Math.abs(totalPaymentEntered - grandTotal) < 0.01 ? Colors.success : Colors.error,
              }]}>₹{totalPaymentEntered.toFixed(2)} / ₹{grandTotal.toFixed(2)}</Text>
            </View>
          )}

          {/* Change due calculator */}
          {(() => {
            const cashEntered = payments.reduce((s, p) => {
              if (p.method === 'cash') return s + (parseFloat(p.amount) || (payments.length === 1 ? grandTotal : 0));
              return s;
            }, 0);
            const changeDue = payments.length === 1 && payments[0].method === 'cash' && !payments[0].amount
              ? 0
              : totalPaymentEntered - grandTotal;
            if (changeDue > 0.01 && cashEntered > 0) {
              return (
                <View style={styles.changeDueBox}>
                  <Ionicons name="cash" size={18} color={Colors.success} />
                  <Text style={styles.changeDueLabel}>Change Due</Text>
                  <Text style={styles.changeDueAmount}>₹{changeDue.toFixed(2)}</Text>
                </View>
              );
            }
            return null;
          })()}
        </View>

        {/* Submit */}
        <TouchableOpacity style={[styles.submitBtn, submitting && { opacity: 0.6 }]} onPress={handleSubmit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
              <Text style={styles.submitBtnText}>
                {orderType === 'pre_order' ? 'Create Pre-order' : 'Complete Sale'} — ₹{grandTotal.toFixed(2)}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },

  sectionTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },

  row: { flexDirection: 'row', gap: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.sm, color: Colors.text, marginTop: Spacing.xs,
  },

  remainingHint: { fontSize: FontSize.xs, color: Colors.warning, marginTop: Spacing.xs, fontWeight: '600' },

  discountToggle: { flexDirection: 'row', marginTop: Spacing.xs },
  discToggleBtn: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  discToggleBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  discToggleText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  discToggleTextActive: { color: Colors.white },

  summaryBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.md,
  },
  summaryTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  summaryItemName: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },
  summaryItemPrice: { fontSize: FontSize.sm, color: Colors.text },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  summaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  summaryValue: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  grandLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  grandValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },

  paymentSection: { marginTop: Spacing.sm },
  paymentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
  },
  splitBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  paymentEntry: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.sm, marginTop: Spacing.xs,
  },
  paymentEntryHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  paymentEntryLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.lg,
  },
  submitBtnText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },

  customerHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs, marginTop: Spacing.xs,
  },
  customerHintText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '500' },

  changeDueBox: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.success + '12', borderRadius: BorderRadius.md,
    padding: Spacing.sm, marginTop: Spacing.sm,
  },
  changeDueLabel: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '600', flex: 1 },
  changeDueAmount: { fontSize: FontSize.md, color: Colors.success, fontWeight: '700' },
});
