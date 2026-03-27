import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Platform, Modal, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function SettlementsScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [tab, setTab] = useState('unsettled'); // unsettled | settlements
  const [unsettled, setUnsettled] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [partners, setPartners] = useState([]);
  const [showPartnerPicker, setShowPartnerPicker] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  const isManager = user?.role === 'owner' || user?.role === 'manager';

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      if (tab === 'unsettled' && selectedPartner) {
        const res = await api.getUnsettledDeliveries({ delivery_partner_id: selectedPartner.id });
        setUnsettled(res.data?.deliveries || []);
      } else if (tab === 'settlements') {
        const params = {};
        if (activeLocation) params.location_id = activeLocation.id;
        const res = await api.getSettlements(params);
        setSettlements(res.data || []);
      }
    } catch (err) {
      console.error('Fetch settlements error:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, selectedPartner, activeLocation]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const fetchPartners = async () => {
    try {
      const res = await api.getUsers({ role: 'delivery_partner', limit: 100 });
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users.filter(u => u.is_active) : []);
    } catch (err) {
      setPartners([]);
    }
    setShowPartnerPicker(true);
  };

  const handleCreateSettlement = async () => {
    if (!selectedPartner || unsettled.length === 0) return;
    const totalAmount = unsettled.reduce((sum, d) => sum + (d.cod_collected || 0), 0);
    const deliveryIds = unsettled.map(d => d.id);

    try {
      setSettlementLoading(true);
      await api.createSettlement({
        delivery_partner_id: selectedPartner.id,
        delivery_ids: deliveryIds,
        total_amount: totalAmount,
        location_id: activeLocation?.id,
      });
      const msg = `Settlement created for ₹${totalAmount.toFixed(0)}`;
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Success', msg);
      fetchData();
    } catch (err) {
      const msg = err.message || 'Failed to create settlement';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setSettlementLoading(false);
    }
  };

  const handleVerify = async (id) => {
    try {
      setSettlementLoading(true);
      await api.verifySettlement(id);
      setConfirmModal(null);
      fetchData();
    } catch (err) {
      const msg = err.message || 'Verification failed';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setSettlementLoading(false);
    }
  };

  const totalUnsettled = unsettled.reduce((sum, d) => sum + (d.cod_collected || 0), 0);

  const renderUnsettled = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <Text style={styles.orderNum}>{item.sale_number}</Text>
        <Text style={styles.amount}>₹{(item.cod_collected || 0).toFixed(0)}</Text>
      </View>
      <View style={styles.cardRow}>
        <Text style={styles.cardSub}>{item.customer_name || 'Customer'}</Text>
        <Text style={styles.cardSub}>{item.delivered_time ? new Date(item.delivered_time).toLocaleDateString() : ''}</Text>
      </View>
    </View>
  );

  const renderSettlement = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => isManager && item.status === 'pending' ? setConfirmModal(item) : null}
    >
      <View style={styles.cardRow}>
        <View>
          <Text style={styles.partnerName}>{item.partner_name}</Text>
          <Text style={styles.cardSub}>{item.total_deliveries} deliveries</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.amount}>₹{(item.total_amount || 0).toFixed(0)}</Text>
          <View style={[styles.statusBadge, { backgroundColor: item.status === 'verified' ? '#E8F5E9' : '#FFF3E0' }]}>
            <Text style={[styles.statusText, { color: item.status === 'verified' ? '#2E7D32' : '#E65100' }]}>
              {item.status === 'verified' ? '✓ Verified' : 'Pending'}
            </Text>
          </View>
        </View>
      </View>
      <Text style={styles.cardDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
      {isManager && item.status === 'pending' && (
        <TouchableOpacity style={styles.verifyBtn} onPress={() => setConfirmModal(item)}>
          <Ionicons name="checkmark-done" size={16} color="#fff" />
          <Text style={styles.verifyBtnText}>Verify Settlement</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity style={[styles.tab, tab === 'unsettled' && styles.tabActive]} onPress={() => setTab('unsettled')}>
          <Ionicons name="wallet-outline" size={18} color={tab === 'unsettled' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'unsettled' && styles.tabTextActive]}>Unsettled COD</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, tab === 'settlements' && styles.tabActive]} onPress={() => setTab('settlements')}>
          <Ionicons name="documents-outline" size={18} color={tab === 'settlements' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'settlements' && styles.tabTextActive]}>Settlements</Text>
        </TouchableOpacity>
      </View>

      {tab === 'unsettled' && (
        <>
          {/* Partner Picker */}
          <TouchableOpacity style={styles.pickerBtn} onPress={fetchPartners}>
            <Ionicons name="person-circle-outline" size={22} color={Colors.primary} />
            <Text style={styles.pickerText}>{selectedPartner ? selectedPartner.name : 'Select Delivery Partner'}</Text>
            <Ionicons name="chevron-down" size={18} color={Colors.textLight} />
          </TouchableOpacity>

          {selectedPartner && (
            <>
              {/* Summary */}
              <View style={styles.summaryCard}>
                <View>
                  <Text style={styles.summaryLabel}>Total Unsettled</Text>
                  <Text style={styles.summaryValue}>₹{totalUnsettled.toFixed(0)}</Text>
                </View>
                <View>
                  <Text style={styles.summaryLabel}>Deliveries</Text>
                  <Text style={styles.summaryValue}>{unsettled.length}</Text>
                </View>
                <TouchableOpacity
                  style={[styles.settleBtn, unsettled.length === 0 && { opacity: 0.5 }]}
                  onPress={handleCreateSettlement}
                  disabled={unsettled.length === 0 || settlementLoading}
                >
                  {settlementLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle" size={20} color="#fff" />
                      <Text style={styles.settleBtnText}>Settle</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              <FlatList
                data={unsettled}
                renderItem={renderUnsettled}
                keyExtractor={item => String(item.id)}
                contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
                refreshing={loading}
                onRefresh={fetchData}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Ionicons name="checkmark-circle-outline" size={48} color={Colors.success} />
                    <Text style={styles.emptyText}>All settled!</Text>
                  </View>
                }
              />
            </>
          )}
        </>
      )}

      {tab === 'settlements' && (
        <FlatList
          data={settlements}
          renderItem={renderSettlement}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
          refreshing={loading}
          onRefresh={fetchData}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="documents-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No settlements yet</Text>
            </View>
          }
        />
      )}

      {/* Partner Picker Modal */}
      <Modal visible={showPartnerPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Partner</Text>
              <TouchableOpacity onPress={() => setShowPartnerPicker(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {partners.map(p => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.partnerItem}
                  onPress={() => { setSelectedPartner(p); setShowPartnerPicker(false); }}
                >
                  <Ionicons name="person-circle" size={36} color={Colors.primary} />
                  <View style={{ marginLeft: 12, flex: 1 }}>
                    <Text style={styles.partnerItemName}>{p.name}</Text>
                    <Text style={styles.partnerItemPhone}>{p.phone}</Text>
                  </View>
                  {selectedPartner?.id === p.id && <Ionicons name="checkmark-circle" size={22} color={Colors.success} />}
                </TouchableOpacity>
              ))}
              {partners.length === 0 && <Text style={styles.emptyText}>No delivery partners found</Text>}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Verify Confirmation Modal */}
      <Modal visible={!!confirmModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: 300 }]}>
            <Text style={styles.modalTitle}>Verify Settlement</Text>
            {confirmModal && (
              <>
                <Text style={styles.confirmText}>
                  Confirm you received ₹{(confirmModal.total_amount || 0).toFixed(0)} from {confirmModal.partner_name}
                  {'\n'}({confirmModal.total_deliveries} deliveries)
                </Text>
                <Text style={[styles.confirmText, { color: Colors.textLight, fontSize: FontSize.xs }]}>
                  This amount will be added to the cash register.
                </Text>
                <View style={styles.confirmBtns}>
                  <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#eee' }]} onPress={() => setConfirmModal(null)}>
                    <Text style={{ fontWeight: '600' }}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: Colors.success }]}
                    onPress={() => handleVerify(confirmModal.id)}
                    disabled={settlementLoading}
                  >
                    {settlementLoading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Verify</Text>}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabRow: { flexDirection: 'row', padding: Spacing.md, paddingBottom: 0, gap: 8 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: BorderRadius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textLight, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  pickerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, margin: Spacing.md, marginBottom: 0, padding: 14, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, gap: 8 },
  pickerText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  summaryCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: Colors.surface, margin: Spacing.md, marginBottom: 0, padding: Spacing.md, borderRadius: BorderRadius.lg, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  summaryValue: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  settleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.success, paddingHorizontal: 20, paddingVertical: 12, borderRadius: BorderRadius.md },
  settleBtnText: { color: '#fff', fontWeight: '700', fontSize: FontSize.md },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderNum: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cardSub: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 2 },
  cardDate: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 6 },
  partnerName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  statusBadge: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: FontSize.xs, fontWeight: '600' },
  verifyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, backgroundColor: Colors.success, paddingVertical: 10, borderRadius: BorderRadius.md },
  verifyBtnText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8, textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, maxHeight: '60%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  partnerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  partnerItemName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partnerItemPhone: { fontSize: FontSize.sm, color: Colors.textLight },
  confirmText: { fontSize: FontSize.md, color: Colors.text, marginVertical: Spacing.md, lineHeight: 22 },
  confirmBtns: { flexDirection: 'row', gap: 12, marginTop: Spacing.md },
  actionBtn: { flex: 1, paddingVertical: 14, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center' },
});
