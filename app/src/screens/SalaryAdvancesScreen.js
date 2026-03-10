import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  RefreshControl, Alert, Platform, Modal, TextInput, ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const confirm = (title, msg, onOk) => {
  if (Platform.OS === 'web') { if (window.confirm(`${title}\n${msg}`)) onOk(); }
  else Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

const STATUS_COLORS = {
  pending: Colors.warning,
  approved: Colors.secondary,
  rejected: Colors.danger,
  repaid: Colors.textLight,
};

const STATUS_ICONS = {
  pending: 'time-outline',
  approved: 'checkmark-circle',
  rejected: 'close-circle',
  repaid: 'checkmark-done-circle',
};

export default function SalaryAdvancesScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [advances, setAdvances] = useState([]);
  const [filter, setFilter] = useState('all');
  const [requestModal, setRequestModal] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const isManagerOrOwner = user?.role === 'owner' || user?.role === 'manager';

  const fetchData = useCallback(async () => {
    try {
      const params = {};
      if (filter !== 'all') params.status = filter;
      const res = await api.getSalaryAdvances(params);
      setAdvances(res.data || []);
    } catch (e) {
      console.error('Fetch advances error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const handleRequest = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      Alert.alert('Error', 'Enter a valid amount.');
      return;
    }
    setActionLoading(true);
    try {
      await api.requestSalaryAdvance({ amount: amt, reason: reason.trim() });
      setRequestModal(false);
      setAmount('');
      setReason('');
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to request advance.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = (id) => {
    confirm('Approve Advance', 'Approve this salary advance?', async () => {
      setActionLoading(true);
      try {
        await api.approveSalaryAdvance(id);
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to approve.');
      } finally {
        setActionLoading(false);
      }
    });
  };

  const handleReject = (id) => {
    confirm('Reject Advance', 'Reject this salary advance?', async () => {
      setActionLoading(true);
      try {
        await api.rejectSalaryAdvance(id);
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to reject.');
      } finally {
        setActionLoading(false);
      }
    });
  };

  const handleRepay = (adv) => {
    confirm('Mark Repaid', `Mark ₹${adv.amount - adv.repaid_amount} as fully repaid?`, async () => {
      setActionLoading(true);
      try {
        await api.repaySalaryAdvance(adv.id, { amount: adv.amount - adv.repaid_amount });
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to record repayment.');
      } finally {
        setActionLoading(false);
      }
    });
  };

  const FILTERS = ['all', 'pending', 'approved', 'rejected', 'repaid'];

  const renderItem = ({ item }) => {
    const color = STATUS_COLORS[item.status] || Colors.textLight;
    const remaining = item.amount - (item.repaid_amount || 0);

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardLeft}>
            <Ionicons name={STATUS_ICONS[item.status]} size={24} color={color} />
            <View style={{ marginLeft: 10 }}>
              {isManagerOrOwner && <Text style={styles.cardName}>{item.user_name}</Text>}
              <Text style={styles.cardDate}>
                {new Date(item.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            </View>
          </View>
          <View style={styles.cardRight}>
            <Text style={styles.cardAmount}>₹{item.amount.toLocaleString()}</Text>
            <View style={[styles.statusBadge, { backgroundColor: color + '20' }]}>
              <Text style={[styles.statusText, { color }]}>{item.status.toUpperCase()}</Text>
            </View>
          </View>
        </View>

        {item.reason ? <Text style={styles.cardReason}>{item.reason}</Text> : null}

        {item.status === 'approved' && remaining > 0 && (
          <View style={styles.repayInfo}>
            <Text style={styles.repayText}>Remaining: ₹{remaining.toLocaleString()}</Text>
            <View style={styles.repayBar}>
              <View style={[styles.repayFill, { width: `${((item.repaid_amount / item.amount) * 100)}%` }]} />
            </View>
          </View>
        )}

        {item.approver_name && (
          <Text style={styles.approverText}>
            {item.status === 'approved' ? 'Approved' : 'Handled'} by {item.approver_name}
          </Text>
        )}

        {/* Manager Actions */}
        {isManagerOrOwner && item.status === 'pending' && (
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.secondary }]}
              onPress={() => handleApprove(item.id)}
              disabled={actionLoading}
            >
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Approve</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.danger }]}
              onPress={() => handleReject(item.id)}
              disabled={actionLoading}
            >
              <Ionicons name="close" size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Reject</Text>
            </TouchableOpacity>
          </View>
        )}

        {isManagerOrOwner && item.status === 'approved' && remaining > 0 && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors.primary, marginTop: Spacing.xs }]}
            onPress={() => handleRepay(item)}
            disabled={actionLoading}
          >
            <Ionicons name="cash" size={16} color="#fff" />
            <Text style={styles.actionBtnText}>Mark Fully Repaid</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // Totals
  const pendingTotal = advances.filter(a => a.status === 'pending').reduce((s, a) => s + a.amount, 0);
  const approvedTotal = advances.filter(a => a.status === 'approved').reduce((s, a) => s + (a.amount - a.repaid_amount), 0);

  return (
    <View style={styles.container}>
      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ paddingHorizontal: Spacing.md }}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Summary Bar */}
      {isManagerOrOwner && (
        <View style={styles.summaryBar}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>Pending</Text>
            <Text style={[styles.summaryVal, { color: Colors.warning }]}>₹{pendingTotal.toLocaleString()}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>Outstanding</Text>
            <Text style={[styles.summaryVal, { color: Colors.danger }]}>₹{approvedTotal.toLocaleString()}</Text>
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>
      ) : (
        <FlatList
          data={advances}
          renderItem={renderItem}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.emptyText}>No salary advances found.</Text>}
        />
      )}

      {/* FAB to request advance */}
      <TouchableOpacity style={styles.fab} onPress={() => setRequestModal(true)}>
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Request Modal */}
      <Modal visible={requestModal} transparent animationType="fade" onRequestClose={() => setRequestModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Request Salary Advance</Text>

            <Text style={styles.fieldLabel}>Amount (₹)</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Enter amount"
              placeholderTextColor={Colors.textLight}
              keyboardType="numeric"
              value={amount}
              onChangeText={setAmount}
            />

            <Text style={styles.fieldLabel}>Reason (optional)</Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 60 }]}
              placeholder="Reason for advance"
              placeholderTextColor={Colors.textLight}
              value={reason}
              onChangeText={setReason}
              multiline
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setRequestModal(false); setAmount(''); setReason(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, (!amount || parseFloat(amount) <= 0) && { opacity: 0.5 }]}
                onPress={handleRequest}
                disabled={!amount || parseFloat(amount) <= 0 || actionLoading}
              >
                <Text style={styles.modalSubmitText}>{actionLoading ? 'Requesting...' : 'Request'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: Spacing.md, paddingBottom: 80 },

  filterRow: { paddingVertical: Spacing.sm, maxHeight: 50 },
  filterChip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: Colors.surface, marginRight: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  filterTextActive: { color: '#fff' },

  summaryBar: {
    flexDirection: 'row', backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md, marginBottom: Spacing.sm,
    borderRadius: BorderRadius.md, padding: Spacing.md,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  summaryVal: { fontSize: FontSize.lg, fontWeight: '800' },
  summaryDivider: { width: 1, backgroundColor: Colors.border },

  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardLeft: { flexDirection: 'row', alignItems: 'center' },
  cardRight: { alignItems: 'flex-end' },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardDate: { fontSize: FontSize.xs, color: Colors.textLight },
  cardAmount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginTop: 4 },
  statusText: { fontSize: 10, fontWeight: '700' },

  cardReason: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  approverText: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: Spacing.xs, fontStyle: 'italic' },

  repayInfo: { marginTop: Spacing.sm },
  repayText: { fontSize: FontSize.sm, color: Colors.text, marginBottom: 4 },
  repayBar: { height: 6, backgroundColor: Colors.border, borderRadius: 3, overflow: 'hidden' },
  repayFill: { height: '100%', backgroundColor: Colors.secondary, borderRadius: 3 },

  cardActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: BorderRadius.md,
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '700' },

  fab: {
    position: 'absolute', bottom: 20, right: 20,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, elevation: 6,
  },

  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: 40 },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: Spacing.lg,
  },
  modalContent: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, width: '100%', maxWidth: 400,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: 4 },
  modalInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.sm,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  modalCancel: { paddingVertical: 10, paddingHorizontal: 20 },
  modalCancelText: { fontSize: FontSize.md, color: Colors.textLight },
  modalSubmit: {
    backgroundColor: Colors.primary, paddingVertical: 10, paddingHorizontal: 20,
    borderRadius: BorderRadius.md,
  },
  modalSubmitText: { fontSize: FontSize.md, fontWeight: '700', color: '#fff' },
});
