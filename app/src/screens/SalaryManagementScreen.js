import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const SALARY_TYPES = [
  { label: 'Monthly', value: 'monthly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Hourly', value: 'hourly' },
];

function formatCurrency(val) {
  if (!val && val !== 0) return '—';
  return '₹' + Number(val).toLocaleString('en-IN');
}

export default function SalaryManagementScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [salaries, setSalaries] = useState([]);
  const [unsetStaff, setUnsetStaff] = useState([]);
  const [modal, setModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyUser, setHistoryUser] = useState(null);

  // Form state
  const [editUser, setEditUser] = useState(null);
  const [amount, setAmount] = useState('');
  const [salaryType, setSalaryType] = useState('monthly');
  const [notes, setNotes] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getSalaries();
      setSalaries(res.data?.salaries || []);
      setUnsetStaff(res.data?.unset || []);
    } catch (e) {
      console.error('Fetch salaries error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const openSetModal = (staffMember, existing = null) => {
    setEditUser(staffMember);
    setAmount(existing ? String(existing.monthly_salary) : '');
    setSalaryType(existing?.salary_type || 'monthly');
    setNotes('');
    setModal(true);
  };

  const handleSave = async () => {
    if (!editUser || !amount || Number(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid salary amount.');
      return;
    }
    setSaving(true);
    try {
      await api.setSalary({
        user_id: editUser.id || editUser.user_id,
        monthly_salary: Number(amount),
        salary_type: salaryType,
        notes: notes.trim() || undefined,
      });
      setModal(false);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to save salary.');
    } finally {
      setSaving(false);
    }
  };

  const viewHistory = async (sal) => {
    setHistoryUser(sal);
    try {
      const res = await api.getSalaryHistory(sal.user_id);
      setHistory(res.data || []);
      setHistoryModal(true);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to load history.');
    }
  };

  const roleBadge = (role) => {
    const colors = { manager: Colors.roleManager, employee: Colors.roleEmployee, delivery_partner: Colors.roleDelivery };
    const labels = { manager: 'Manager', employee: 'Employee', delivery_partner: 'Delivery' };
    return (
      <View style={[styles.badge, { backgroundColor: colors[role] || Colors.textLight }]}>
        <Text style={styles.badgeText}>{labels[role] || role}</Text>
      </View>
    );
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {/* Staff without salaries */}
      {unsetStaff.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Salary Not Set</Text>
          {unsetStaff.map(s => (
            <TouchableOpacity
              key={s.id}
              style={styles.unsetCard}
              onPress={() => openSetModal(s)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{s.name}</Text>
                <View style={styles.metaRow}>
                  {roleBadge(s.role)}
                  <Text style={styles.metaText}>{s.phone}</Text>
                </View>
              </View>
              <View style={styles.setBtn}>
                <Ionicons name="add-circle" size={24} color={Colors.primary} />
                <Text style={styles.setBtnText}>Set</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Staff with salaries */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Staff Salaries {salaries.length > 0 ? `(${salaries.length})` : ''}
        </Text>
        {salaries.length === 0 && unsetStaff.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="wallet-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No staff members yet</Text>
          </View>
        ) : (
          salaries.map(s => (
            <View key={s.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{s.user_name}</Text>
                  <View style={styles.metaRow}>
                    {roleBadge(s.user_role)}
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.salaryAmount}>{formatCurrency(s.monthly_salary)}</Text>
                  <Text style={styles.salaryType}>
                    {s.salary_type === 'monthly' ? '/month' : s.salary_type === 'daily' ? '/day' : '/hour'}
                  </Text>
                </View>
              </View>
              <View style={styles.cardFooter}>
                <TouchableOpacity style={styles.linkBtn} onPress={() => openSetModal(s, s)}>
                  <Ionicons name="create-outline" size={16} color={Colors.primary} />
                  <Text style={styles.linkBtnText}>Update</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.linkBtn} onPress={() => viewHistory(s)}>
                  <Ionicons name="time-outline" size={16} color={Colors.info} />
                  <Text style={[styles.linkBtnText, { color: Colors.info }]}>History</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>

      {/* ─── Set/Update Salary Modal ─────────────────────── */}
      <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {editUser ? `Set Salary — ${editUser.name || editUser.user_name}` : 'Set Salary'}
            </Text>

            <Text style={styles.label}>Salary Amount (₹)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              placeholder="e.g. 15000"
              placeholderTextColor={Colors.textLight}
            />

            <Text style={styles.label}>Type</Text>
            <View style={styles.typeRow}>
              {SALARY_TYPES.map(t => (
                <TouchableOpacity
                  key={t.value}
                  style={[styles.typeChip, salaryType === t.value && styles.typeChipActive]}
                  onPress={() => setSalaryType(t.value)}
                >
                  <Text style={[styles.typeChipText, salaryType === t.value && styles.typeChipTextActive]}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Reason / Notes</Text>
            <TextInput
              style={[styles.input, { height: 60 }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional — reason for change"
              placeholderTextColor={Colors.textLight}
              multiline
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setModal(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
                <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ─── Salary History Modal ────────────────────────── */}
      <Modal visible={historyModal} transparent animationType="slide" onRequestClose={() => setHistoryModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              Salary History — {historyUser?.user_name}
            </Text>
            {history.length === 0 ? (
              <Text style={styles.emptyText}>No salary changes recorded.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 300 }}>
                {history.map(h => (
                  <View key={h.id} style={styles.historyRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyChange}>
                        {formatCurrency(h.old_salary)} → {formatCurrency(h.new_salary)}
                      </Text>
                      {h.reason ? <Text style={styles.historyReason}>{h.reason}</Text> : null}
                      <Text style={styles.historyMeta}>
                        by {h.changed_by_name} • {new Date(h.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[styles.saveBtn, { alignSelf: 'flex-end', marginTop: Spacing.md }]}
              onPress={() => setHistoryModal(false)}
            >
              <Text style={styles.saveBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  section: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  unsetCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: Colors.warningLight, borderStyle: 'dashed',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.md,
  },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  metaText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginLeft: Spacing.sm },
  badge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  badgeText: { fontSize: FontSize.xs, color: '#fff', fontWeight: '600' },
  salaryAmount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.secondary },
  salaryType: { fontSize: FontSize.xs, color: Colors.textLight },
  cardFooter: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: Colors.border,
    padding: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  linkBtn: { flexDirection: 'row', alignItems: 'center', marginRight: Spacing.lg },
  linkBtnText: { fontSize: FontSize.sm, color: Colors.primary, marginLeft: 4 },
  setBtn: { alignItems: 'center' },
  setBtnText: { fontSize: FontSize.xs, color: Colors.primary, marginTop: 2 },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
    backgroundColor: Colors.background,
  },
  typeRow: { flexDirection: 'row' },
  typeChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.sm,
  },
  typeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeChipText: { fontSize: FontSize.sm, color: Colors.text },
  typeChipTextActive: { color: '#fff', fontWeight: '600' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: Spacing.lg },
  cancelBtn: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, marginRight: Spacing.sm },
  cancelBtnText: { color: Colors.textSecondary, fontSize: FontSize.md },
  saveBtn: {
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  // History
  historyRow: {
    paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  historyChange: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  historyReason: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  historyMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 4 },
});
