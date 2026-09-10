import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { showAlert } from '../../utils/alert';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';

/**
 * "Collect COD & Mark Delivered" — Mark Delivered needs a real amount/method
 * the same way Start Preparing sometimes needs a preparer (see
 * resolveDeliverStep, OrderCard.js). Self-contained: takes just `order` and
 * fires PUT /deliveries/:id/deliver (via api.advanceOrder using the order's
 * own display_stage.nextAction) with cod_collected/cod_method attached, then
 * calls onDone so the caller can refresh its own list. Extracted from
 * DashboardScreen.js (2026-09-10) so Orders Inbox's inline resolution uses
 * the identical, already-tested flow rather than a second copy that could
 * drift — see DashboardScreen.js's handleResolveAction 'collect_cod' branch
 * for the original context this was pulled from. Amount is capped to what's
 * actually outstanding so a typo can't overshoot into the server's own "COD
 * collection exceeds remaining amount" 400.
 */
export default function CollectCodModal({ visible, order, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [loading, setLoading] = useState(false);

  // Reset/pre-fill whenever the modal opens for a (possibly new) order —
  // mirrors DashboardScreen's handleResolveAction pre-filling the outstanding
  // amount so the common case (paid in full) is a single confirm tap.
  useEffect(() => {
    if (!visible || !order) return;
    const outstanding = Number(order.cod_amount || 0) - Number(order.cod_collected || 0);
    setAmount(outstanding > 0 ? outstanding.toFixed(2) : '');
    setMethod('cash');
    setLoading(false);
  }, [visible, order]);

  if (!order) return null;

  const outstanding = Number(order.cod_amount || 0) - Number(order.cod_collected || 0);

  const handleSubmit = async () => {
    const nextAction = order.display_stage?.nextAction;
    if (!nextAction) {
      onClose();
      showAlert('Mark Delivered', 'This order has already moved on. Pull down to refresh.');
      return;
    }
    const entered = parseFloat(amount) || 0;
    if (entered <= 0) {
      showAlert('Mark Delivered', 'Enter the amount collected, or the exact outstanding amount if paid in full.');
      return;
    }
    if (entered > outstanding + 0.01) {
      showAlert('Mark Delivered', `Only ₹${outstanding.toFixed(2)} is outstanding on this order.`);
      return;
    }
    setLoading(true);
    try {
      await api.advanceOrder(nextAction, { cod_collected: entered, cod_method: method });
      onDone?.();
    } catch (err) {
      setLoading(false);
      showAlert('Mark Delivered', err?.message || 'Could not record this. Please try again.');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Collect COD & Mark Delivered</Text>
            <TouchableOpacity onPress={onClose} hitSlop={5}>
              <Ionicons name="close" size={20} color="#6B7280" />
            </TouchableOpacity>
          </View>
          <View style={styles.content}>
            <Text style={styles.label}>Amount Collected</Text>
            <TextInput
              style={styles.amountInput}
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor="#9CA3AF"
              editable={!loading}
            />
            <Text style={styles.label}>Method</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {['cash', 'upi'].map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.methodChip, method === m && styles.methodChipActive]}
                  onPress={() => setMethod(m)}
                  disabled={loading}
                >
                  <Text style={[styles.methodChipText, method === m && styles.methodChipTextActive]}>{m.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <TouchableOpacity style={[styles.confirmBtn, loading && { opacity: 0.6 }]} onPress={handleSubmit} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnText}>Confirm & Mark Delivered</Text>}
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, marginTop: 'auto', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  title: { fontSize: 16, fontWeight: '800', color: '#111827', flex: 1, fontFamily: FONT_FAMILY },
  content: { gap: 12, marginBottom: 14 },
  label: { fontSize: 11, color: '#6B7280', fontWeight: '700', fontFamily: FONT_FAMILY },
  amountInput: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 18, fontWeight: '700', color: '#111827', fontFamily: FONT_FAMILY },
  methodChip: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surfaceAlt },
  methodChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + '18' },
  methodChipText: { fontSize: 14, fontWeight: '700', color: '#6B7280', fontFamily: FONT_FAMILY },
  methodChipTextActive: { color: Colors.primary },
  confirmBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: Colors.primary },
  confirmBtnText: { fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: FONT_FAMILY },
});
