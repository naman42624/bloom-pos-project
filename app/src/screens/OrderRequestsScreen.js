import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
];

function itemsSummary(itemsJson) {
  const items = Array.isArray(itemsJson) ? itemsJson : [];
  if (items.length === 0) return 'No items';
  const names = items.map((it) => it.custom ? it.description : (it.name || `Product #${it.product_id}`));
  return `${items.length} item${items.length > 1 ? 's' : ''}: ${names.join(', ')}`;
}

export default function OrderRequestsScreen({ navigation }) {
  const guardSubmit = useSubmitGuard();
  const [status, setStatus] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  const fetchRequests = useCallback(async (currentStatus) => {
    try {
      const res = await api.getOrderRequests({ status: currentStatus });
      setRequests(res.data.requests || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not load order requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchRequests(status);
    }, [status, fetchRequests])
  );

  const handleApprove = (request) => {
    navigation.navigate('LogOrder', { prefillRequest: request, prefillToken: Date.now() });
  };

  const submitDecline = async () => {
    setDeclining(true);
    try {
      await api.declineOrderRequest(declineTarget.id, declineReason.trim() || undefined);
      setDeclineTarget(null);
      setDeclineReason('');
      fetchRequests(status);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not decline this request');
    } finally {
      setDeclining(false);
    }
  };

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.customerName}>{item.customer_name || 'Unknown customer'}</Text>
        <Text style={styles.orderTypeBadge}>{item.order_type === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
      </View>
      <Text style={styles.recipientText}>For: {item.recipient_name} · {item.recipient_phone}</Text>
      <Text style={styles.dateText}>Requested for {item.requested_date}{item.requested_time ? `, ${item.requested_time}` : ''}</Text>
      <Text style={styles.itemsText} numberOfLines={2}>{itemsSummary(item.items_json)}</Text>
      <View style={styles.metaRow}>
        {item.payment_claimed && (
          <View style={styles.paidChip}><Text style={styles.paidChipText}>Says paid</Text></View>
        )}
        <Text style={styles.submittedAt}>Submitted {new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
      {item.payment_claimed && item.payment_reference && (
        <Text style={styles.paymentRefText}>Ref: {item.payment_reference}</Text>
      )}
      {item.status === 'declined' && item.decline_reason && (
        <Text style={styles.declineReasonText}>Declined: {item.decline_reason}</Text>
      )}
      {item.status === 'pending' && (
        <View style={styles.actionsRow}>
          <Button title="Decline" variant="outline" size="sm" onPress={() => setDeclineTarget(item)} style={{ flex: 1 }} />
          <Button title="Approve" size="sm" onPress={guardSubmit(() => handleApprove(item))} style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity key={f.key} style={[styles.filterChip, status === f.key && styles.filterChipActive]} onPress={() => setStatus(f.key)}>
            <Text style={[styles.filterChipText, status === f.key && styles.filterChipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: Spacing.xl }} />
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchRequests(status); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.emptyText}>No {status} requests.</Text>}
        />
      )}

      <Modal visible={!!declineTarget} transparent animationType="fade" onRequestClose={() => setDeclineTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Decline this request?</Text>
            <Text style={styles.modalSubtitle}>The customer will see this reason on their status page.</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Reason (optional)"
              value={declineReason}
              onChangeText={setDeclineReason}
              multiline
              placeholderTextColor={Colors.textLight}
            />
            <View style={styles.modalActions}>
              <Button title="Cancel" variant="ghost" onPress={() => setDeclineTarget(null)} style={{ flex: 1 }} />
              <Button title="Confirm Decline" variant="danger" loading={declining} onPress={guardSubmit(submitDecline)} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  filterRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md },
  filterChip: { paddingVertical: Spacing.xs, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.sm },
  filterChipTextActive: { color: Colors.white },
  listContent: { padding: Spacing.md, paddingTop: 0 },
  emptyText: { textAlign: 'center', color: Colors.textLight, marginTop: Spacing.xl },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  customerName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  orderTypeBadge: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary, backgroundColor: Colors.primary + '18', paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  recipientText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  dateText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  itemsText: { fontSize: FontSize.sm, color: Colors.text, marginTop: Spacing.xs },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.sm },
  paidChip: { backgroundColor: Colors.success + '18', paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  paidChipText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: '700' },
  paymentRefText: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  submittedAt: { fontSize: FontSize.xs, color: Colors.textLight },
  declineReasonText: { fontSize: FontSize.sm, color: Colors.error, marginTop: Spacing.xs, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: Spacing.lg },
  modalCard: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 400 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs, marginBottom: Spacing.md },
  modalInput: { backgroundColor: Colors.background, borderRadius: BorderRadius.sm, padding: Spacing.md, minHeight: 60, textAlignVertical: 'top', borderWidth: 1, borderColor: Colors.border, color: Colors.text },
  modalActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
});
