import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  Platform, Modal, ScrollView, ActivityIndicator, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius, Shadows } from '../constants/theme';
import { formatDate } from '../utils/datetime';

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function SettlementsScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [tab, setTab] = useState('pending'); // pending | history
  const [partners, setPartners] = useState([]);          // pending COD grouped by partner
  const [history, setHistory] = useState([]);            // past settlement records
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);

  // Expanded partner card (shows individual deliveries)
  const [expandedPartner, setExpandedPartner] = useState(null);
  const [expandedHistory, setExpandedHistory] = useState(null);
  const [partnerDeliveries, setPartnerDeliveries] = useState({});
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  // Selection state: { [partnerId]: Set<deliveryId> | 'all' }
  const [selection, setSelection] = useState({});

  // Confirm modal
  const [confirmData, setConfirmData] = useState(null); // { partnerId, partnerName, amount, deliveryIds }

  const isManager = user?.role === 'owner' || user?.role === 'manager';

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'pending') {
        const locId = activeLocation?.id;
        const res = await api.getPendingCodSummary(locId);
        setPartners(res.data?.partners || []);
        setExpandedPartner(null);
        setPartnerDeliveries({});
        setSelection({});
      } else {
        const params = {};
        if (activeLocation) params.location_id = activeLocation.id;
        const res = await api.getSettlements(params);
        setHistory(res.data || []);
      }
    } catch (err) {
      console.error('Settlements fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, activeLocation]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  // Expand/collapse a partner card and lazy-load their individual deliveries
  const togglePartner = async (partner) => {
    const pid = partner.delivery_partner_id;
    if (expandedPartner === pid) {
      setExpandedPartner(null);
      return;
    }
    setExpandedPartner(pid);
    if (!partnerDeliveries[pid]) {
      setLoadingDeliveries(true);
      try {
        const res = await api.getUnsettledDeliveries({ delivery_partner_id: pid });
        setPartnerDeliveries(prev => ({ ...prev, [pid]: res.data?.deliveries || [] }));
        // Default: select all
        const allIds = new Set((res.data?.deliveries || []).map(d => d.id));
        setSelection(prev => ({ ...prev, [pid]: allIds }));
      } catch {
        setPartnerDeliveries(prev => ({ ...prev, [pid]: [] }));
      } finally {
        setLoadingDeliveries(false);
      }
    }
  };

  const toggleHistory = (id) => {
    setExpandedHistory(prev => prev === id ? null : id);
  };

  const toggleDeliverySelection = (partnerId, deliveryId) => {
    setSelection(prev => {
      const current = prev[partnerId] ? new Set(prev[partnerId]) : new Set();
      if (current.has(deliveryId)) current.delete(deliveryId);
      else current.add(deliveryId);
      return { ...prev, [partnerId]: current };
    });
  };

  const selectAllForPartner = (partnerId) => {
    const deliveries = partnerDeliveries[partnerId] || [];
    setSelection(prev => ({ ...prev, [partnerId]: new Set(deliveries.map(d => d.id)) }));
  };

  const deselectAllForPartner = (partnerId) => {
    setSelection(prev => ({ ...prev, [partnerId]: new Set() }));
  };

  const prepareSettle = (partner) => {
    const pid = partner.delivery_partner_id;
    const deliveries = partnerDeliveries[pid];
    let amount, deliveryIds;

    if (!deliveries) {
      // Partner not expanded — settle ALL
      amount = Number(partner.total_cod);
      deliveryIds = null; // backend will find all
    } else {
      const sel = selection[pid] || new Set();
      deliveryIds = [...sel];
      if (deliveryIds.length === 0) {
        Alert.alert('No deliveries selected', 'Select at least one delivery to settle.');
        return;
      }
      amount = deliveries
        .filter(d => sel.has(d.id))
        .reduce((s, d) => s + Number(d.cod_collected || 0), 0);
    }

    setConfirmData({
      partnerId: pid,
      partnerName: partner.partner_name,
      amount,
      deliveryIds,
      deliveryCount: deliveryIds ? deliveryIds.length : Number(partner.delivery_count),
    });
  };

  const handleSettleConfirm = async () => {
    if (!confirmData) return;
    setSettling(true);
    try {
      await api.settleNow({
        delivery_partner_id: confirmData.partnerId,
        delivery_ids: confirmData.deliveryIds || undefined,
        location_id: activeLocation?.id,
      });
      setConfirmData(null);
      const msg = `₹${fmt(confirmData.amount)} settled and added to cash register.`;
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('✓ Settled', msg);
      fetchData();
    } catch (err) {
      const msg = err.message || 'Settlement failed';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setSettling(false);
    }
  };

  const totalPending = partners.reduce((s, p) => s + Number(p.total_cod || 0), 0);

  // ── Render helpers ─────────────────────────────────────────

  const renderDeliveryRow = (partnerId, delivery) => {
    const sel = selection[partnerId] || new Set();
    const selected = sel.has(delivery.id);
    return (
      <TouchableOpacity
        key={delivery.id}
        style={[styles.deliveryRow, selected && styles.deliveryRowSelected]}
        onPress={() => toggleDeliverySelection(partnerId, delivery.id)}
        activeOpacity={0.7}
      >
        <View style={[styles.checkbox, selected && styles.checkboxChecked]}>
          {selected && <Ionicons name="checkmark" size={12} color="#fff" />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.deliveryOrderNum}>{delivery.sale_number || `#${delivery.id}`}</Text>
          <Text style={styles.deliverySub}>{delivery.customer_name || 'Customer'}</Text>
        </View>
        <Text style={[styles.deliveryAmount, selected && { color: Colors.success }]}>
          ₹{fmt(delivery.cod_collected)}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderPartnerCard = ({ item: partner }) => {
    const pid = partner.delivery_partner_id;
    const isExpanded = expandedPartner === pid;
    const deliveries = partnerDeliveries[pid];
    const sel = selection[pid] || new Set();
    const selCount = sel.size;
    const selAmount = deliveries
      ? deliveries.filter(d => sel.has(d.id)).reduce((s, d) => s + Number(d.cod_collected || 0), 0)
      : Number(partner.total_cod);

    const allSelected = deliveries && sel.size === deliveries.length;

    return (
      <View style={styles.partnerCard}>
        {/* Partner Header */}
        <TouchableOpacity style={styles.partnerHeader} onPress={() => togglePartner(partner)} activeOpacity={0.8}>
          <View style={styles.partnerAvatar}>
            <Ionicons name="bicycle" size={22} color={Colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.partnerName}>{partner.partner_name || 'Unknown Partner'}</Text>
            <Text style={styles.partnerMeta}>{partner.delivery_count} deliveries pending</Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={styles.partnerAmount}>₹{fmt(partner.total_cod)}</Text>
            <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textLight} />
          </View>
        </TouchableOpacity>

        {/* Expanded: individual delivery list */}
        {isExpanded && (
          <View style={styles.deliveryList}>
            <View style={styles.deliveryListHeader}>
              <TouchableOpacity
                onPress={() => allSelected ? deselectAllForPartner(pid) : selectAllForPartner(pid)}
              >
                <Text style={styles.selectAllBtn}>{allSelected ? 'Deselect All' : 'Select All'}</Text>
              </TouchableOpacity>
              {selCount > 0 && (
                <Text style={styles.selectionSummary}>{selCount} selected · ₹{fmt(selAmount)}</Text>
              )}
            </View>
            {loadingDeliveries && !deliveries
              ? <ActivityIndicator color={Colors.primary} style={{ marginVertical: 16 }} />
              : (deliveries || []).map(d => renderDeliveryRow(pid, d))
            }
          </View>
        )}

        {/* Settle button */}
        <TouchableOpacity
          style={[
            styles.settleBtn,
            isExpanded && selCount === 0 && { opacity: 0.4 },
          ]}
          onPress={() => prepareSettle(partner)}
          disabled={isExpanded && selCount === 0}
          activeOpacity={0.8}
        >
          <Ionicons name="cash" size={18} color="#fff" />
          <Text style={styles.settleBtnText}>
            {isExpanded
              ? selCount === 0 ? 'Select deliveries' : `Settle ${selCount} · ₹${fmt(selAmount)} → Register`
              : `Settle All · ₹${fmt(partner.total_cod)} → Register`
            }
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderHistoryCard = ({ item }) => {
    const isExpanded = expandedHistory === item.id;
    return (
      <View style={styles.histCard}>
        <TouchableOpacity style={styles.histRow} onPress={() => toggleHistory(item.id)} activeOpacity={0.7}>
          <View>
            <Text style={styles.histPartner}>{item.partner_name || 'Partner'}</Text>
            <Text style={styles.histMeta}>{item.total_deliveries} deliveries · {formatDate(item.settlement_date)}</Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={styles.histAmount}>₹{fmt(item.total_amount)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
               <View style={[styles.verifiedBadge, { marginTop: 0 }]}>
                 <Ionicons name="checkmark-circle" size={12} color={Colors.success} />
                 <Text style={styles.verifiedText}>Settled</Text>
               </View>
               <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textLight} />
            </View>
          </View>
        </TouchableOpacity>
        
        {item.verified_by_name && !isExpanded && (
          <Text style={styles.histFooter}>Settled by {item.verified_by_name}</Text>
        )}
        
        {isExpanded && (
          <View style={styles.historyDetailList}>
             <View style={styles.historyDetailHeader}>
               <Text style={styles.historyDetailTitle}>Settled Orders</Text>
               <Text style={styles.historyDetailTitleText}>{item.deliveries?.length || 0} orders</Text>
             </View>
             {item.deliveries && item.deliveries.map(d => (
                <View key={d.delivery_id} style={styles.historyDetailRow}>
                   <View style={{ flex: 1 }}>
                     <Text style={styles.historyDeliveryOrderNum}>{d.sale_number || `#${d.delivery_id}`}</Text>
                     <Text style={styles.historyDeliverySub}>{d.customer_name || 'Customer'}</Text>
                   </View>
                   <Text style={styles.historyDeliveryAmount}>₹{fmt(d.amount)}</Text>
                </View>
             ))}
             {item.verified_by_name && (
               <View style={styles.historyDetailFooter}>
                 <Text style={styles.historyDetailFooterText}>Settled by {item.verified_by_name}</Text>
                 <Text style={styles.historyDetailFooterTime}>{item.verified_at ? formatDate(item.verified_at) : ''}</Text>
               </View>
             )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Tab Row */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, tab === 'pending' && styles.tabActive]}
          onPress={() => setTab('pending')}
        >
          <Ionicons name="wallet" size={16} color={tab === 'pending' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'pending' && styles.tabTextActive]}>Pending COD</Text>
          {partners.length > 0 && tab !== 'pending' && (
            <View style={styles.tabBadge}><Text style={styles.tabBadgeText}>{partners.length}</Text></View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'history' && styles.tabActive]}
          onPress={() => setTab('history')}
        >
          <Ionicons name="time" size={16} color={tab === 'history' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'history' && styles.tabTextActive]}>History</Text>
        </TouchableOpacity>
      </View>

      {/* Pending COD tab */}
      {tab === 'pending' && (
        <>
          {/* Summary banner */}
          {totalPending > 0 && (
            <View style={styles.summaryBanner}>
              <View>
                <Text style={styles.summaryLabel}>Total Pending COD</Text>
                <Text style={styles.summaryAmount}>₹{fmt(totalPending)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.summaryLabel}>From</Text>
                <Text style={styles.summaryCount}>{partners.length} partner{partners.length !== 1 ? 's' : ''}</Text>
              </View>
            </View>
          )}

          {loading ? (
            <ActivityIndicator color={Colors.primary} style={{ marginTop: 48 }} />
          ) : (
            <FlatList
              data={partners}
              renderItem={renderPartnerCard}
              keyExtractor={item => String(item.delivery_partner_id)}
              contentContainerStyle={styles.listContent}
              refreshing={loading}
              onRefresh={fetchData}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="checkmark-circle" size={56} color={Colors.success} />
                  <Text style={styles.emptyTitle}>All Settled!</Text>
                  <Text style={styles.emptySub}>No pending COD from any delivery partner.</Text>
                </View>
              }
            />
          )}
        </>
      )}

      {/* History tab */}
      {tab === 'history' && (
        loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 48 }} />
        ) : (
          <FlatList
            data={history}
            renderItem={renderHistoryCard}
            keyExtractor={item => String(item.id)}
            contentContainerStyle={styles.listContent}
            refreshing={loading}
            onRefresh={fetchData}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="document-text-outline" size={56} color={Colors.textLight} />
                <Text style={styles.emptyTitle}>No History Yet</Text>
                <Text style={styles.emptySub}>Settled COD records will appear here.</Text>
              </View>
            }
          />
        )
      )}

      {/* Confirm Settlement Modal */}
      <Modal visible={!!confirmData} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalIconRow}>
              <View style={styles.modalIcon}>
                <Ionicons name="cash-outline" size={32} color={Colors.success} />
              </View>
            </View>
            <Text style={styles.modalTitle}>Confirm Settlement</Text>
            {confirmData && (
              <>
                <Text style={styles.modalBody}>
                  You are settling{' '}
                  <Text style={{ fontWeight: '700' }}>
                    {confirmData.deliveryCount} deliver{confirmData.deliveryCount !== 1 ? 'ies' : 'y'}
                  </Text>
                  {' '}from{' '}
                  <Text style={{ fontWeight: '700' }}>{confirmData.partnerName}</Text>
                </Text>
                <View style={styles.modalAmountBox}>
                  <Text style={styles.modalAmountLabel}>Adding to Cash Register</Text>
                  <Text style={styles.modalAmountValue}>₹{fmt(confirmData.amount)}</Text>
                </View>
                <Text style={styles.modalNote}>
                  This will immediately credit the full amount to the open register and mark deliveries as settled.
                </Text>
              </>
            )}
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setConfirmData(null)}
                disabled={settling}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, settling && { opacity: 0.6 }]}
                onPress={handleSettleConfirm}
                disabled={settling}
              >
                {settling
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <>
                      <Ionicons name="checkmark-circle" size={18} color="#fff" />
                      <Text style={styles.confirmBtnText}>Settle & Add to Register</Text>
                    </>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  tabRow: {
    flexDirection: 'row', gap: 8,
    padding: Spacing.md, paddingBottom: Spacing.sm,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textLight, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  tabBadge: {
    backgroundColor: Colors.error, borderRadius: 99,
    paddingHorizontal: 6, paddingVertical: 1, minWidth: 18, alignItems: 'center',
  },
  tabBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  summaryBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: Spacing.md, marginBottom: Spacing.sm,
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: 1, borderColor: '#FDE68A',
  },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  summaryAmount: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, marginTop: 2 },
  summaryCount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: 2 },

  listContent: { padding: Spacing.md, paddingBottom: 100, gap: Spacing.sm },

  // Partner card
  partnerCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    ...Shadows.md, overflow: 'hidden',
  },
  partnerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: Spacing.md,
  },
  partnerAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.primaryGlow,
    alignItems: 'center', justifyContent: 'center',
  },
  partnerName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  partnerMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  partnerAmount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },

  // Delivery list
  deliveryList: { borderTopWidth: 1, borderTopColor: Colors.border },
  deliveryListHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surfaceAlt,
  },
  selectAllBtn: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  selectionSummary: { fontSize: FontSize.xs, color: Colors.textSecondary },
  deliveryRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  deliveryRowSelected: { backgroundColor: Colors.successLight },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: Colors.success, borderColor: Colors.success },
  deliveryOrderNum: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  deliverySub: { fontSize: FontSize.xs, color: Colors.textLight },
  deliveryAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  // Settle button
  settleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, margin: Spacing.sm, marginTop: 0,
    backgroundColor: Colors.success, borderRadius: BorderRadius.md,
    paddingVertical: 13,
  },
  settleBtnText: { color: '#fff', fontWeight: '700', fontSize: FontSize.sm },

  // History
  histCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, ...Shadows.sm,
  },
  histRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  histPartner: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  histMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 3 },
  histAmount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  verifiedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    marginTop: 4, backgroundColor: Colors.successLight,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99,
  },
  verifiedText: { fontSize: 11, fontWeight: '600', color: Colors.success },
  histFooter: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 8 },

  // History Details
  historyDetailList: { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: Spacing.md },
  historyDetailHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  historyDetailTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  historyDetailTitleText: { fontSize: FontSize.xs, color: Colors.textLight },
  historyDetailRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8, borderTopWidth: 1, borderTopColor: Colors.borderLight || '#F3F4F6',
  },
  historyDeliveryOrderNum: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  historyDeliverySub: { fontSize: FontSize.xs, color: Colors.textLight },
  historyDeliveryAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary },
  historyDetailFooter: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  historyDetailFooterText: { fontSize: FontSize.xs, color: Colors.textLight, fontWeight: '500' },
  historyDetailFooterTime: { fontSize: FontSize.xs, color: Colors.textLight },

  // Empty
  empty: { alignItems: 'center', paddingTop: 64, gap: 10 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  emptySub: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', maxWidth: 260 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: Spacing.lg, paddingBottom: 36,
  },
  modalHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border,
    alignSelf: 'center', marginBottom: Spacing.md,
  },
  modalIconRow: { alignItems: 'center', marginBottom: Spacing.md },
  modalIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Colors.successLight,
    alignItems: 'center', justifyContent: 'center',
  },
  modalTitle: {
    fontSize: FontSize.xl, fontWeight: '800', color: Colors.text,
    textAlign: 'center', marginBottom: Spacing.sm,
  },
  modalBody: {
    fontSize: FontSize.md, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22, marginBottom: Spacing.md,
  },
  modalAmountBox: {
    backgroundColor: Colors.successLight, borderRadius: BorderRadius.lg,
    padding: Spacing.md, alignItems: 'center', marginBottom: Spacing.md,
  },
  modalAmountLabel: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '600' },
  modalAmountValue: { fontSize: 32, fontWeight: '900', color: Colors.success, marginTop: 4 },
  modalNote: {
    fontSize: FontSize.xs, color: Colors.textLight,
    textAlign: 'center', lineHeight: 18, marginBottom: Spacing.lg,
  },
  modalBtns: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceAlt, alignItems: 'center',
  },
  cancelBtnText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary },
  confirmBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: BorderRadius.md,
    backgroundColor: Colors.success,
  },
  confirmBtnText: { fontSize: FontSize.md, fontWeight: '700', color: '#fff' },
});
