import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, SectionList, TouchableOpacity, StyleSheet, TextInput, Alert, Platform, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { 
  parseServerDate, formatDateTime, formatShopDateLabel, 
  getShopNow, getShopTodayStr, getShopTomorrowStr 
} from '../utils/datetime';


const STATUS_TABS = [
  { key: 'active', label: 'Active (To-Do)' },
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'picked_up', label: 'Picked Up' },
  { key: 'in_transit', label: 'In Transit' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'failed', label: 'Failed' },
];

const STATUS_COLORS = {
  pending: '#FF9800',
  assigned: '#2196F3',
  picked_up: '#9C27B0',
  in_transit: '#00BCD4',
  delivered: '#4CAF50',
  failed: '#F44336',
  cancelled: '#9E9E9E',
};

export default function DeliveriesScreen({ navigation }) {
  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone || 'Asia/Kolkata';

  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [partners, setPartners] = useState([]);
  const [atRiskIds, setAtRiskIds] = useState(new Set());
  const [now, setNow] = useState(getShopNow(timezone));

  const tickRef = useRef(null);

  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);

  const isManager = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';

  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Tick every 60s to update countdowns
  useEffect(() => {
    tickRef.current = setInterval(() => setNow(getShopNow(timezone)), 60000);
    return () => clearInterval(tickRef.current);
  }, [timezone]);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await api.getLocations();
      const locs = (res.data?.locations || res.data || []).filter(l => (l.type === 'shop' || l.type == null) && l.is_active);
      setLocations(locs);
      if (locs.length > 0 && selectedLocation === null && !isOwner) {
        const defaultLoc = activeLocation && locs.some(l => l.id === activeLocation.id) ? activeLocation.id : locs[0].id;
        setSelectedLocation(defaultLoc);
      }
    } catch (err) { console.error('Error fetching locations:', err); }
  }, [activeLocation, isOwner, selectedLocation]);

  useFocusEffect(useCallback(() => { fetchLocations(); }, [fetchLocations]));

  const fetchDeliveries = useCallback(async () => {
    try {
      setLoading(true);
      const params = { limit: 200 };
      if (selectedLocation) params.location_id = selectedLocation;
      if (statusFilter !== 'all') params.status = statusFilter;

      const [deliveriesRes, atRiskRes] = await Promise.all([
        api.getDeliveries(params),
        isManager ? api.getAtRiskOrders(selectedLocation ? { location_id: selectedLocation } : {}).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      ]);

      setDeliveries(deliveriesRes.data || []);

      // Build set of at-risk delivery IDs
      const riskIds = new Set();
      for (const r of (atRiskRes.data || [])) {
        if (r.delivery_id) riskIds.add(r.delivery_id);
      }
      setAtRiskIds(riskIds);
    } catch (err) {
      console.error('Fetch deliveries error:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, statusFilter, isManager]);

  useFocusEffect(useCallback(() => { fetchDeliveries(); }, [fetchDeliveries]));

  const openAssignModal = async (delivery) => {
    setSelectedDelivery(delivery);
    try {
      const res = await api.getUsers({ role: 'delivery_partner', limit: 100 });
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users.filter(u => u.is_active) : []);
    } catch (err) {
      console.error('Fetch partners error:', err);
      setPartners([]);
    }
    setAssignModalVisible(true);
  };

  const handleAssign = async (partnerId) => {
    try {
      if (batchMode && selectedIds.size > 0) {
        const res = await api.batchAssignDeliveries({
          delivery_ids: Array.from(selectedIds),
          delivery_partner_id: partnerId,
        });
        const msg = res.message || `Assigned ${selectedIds.size} deliveries`;
        Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Success', msg);
        setSelectedIds(new Set());
        setBatchMode(false);
      } else {
        await api.assignDelivery(selectedDelivery.id, { delivery_partner_id: partnerId });
      }
      setAssignModalVisible(false);
      fetchDeliveries();
    } catch (err) {
      const msg = err.message || 'Failed to assign';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openBatchAssignModal = async () => {
    if (selectedIds.size === 0) {
      const msg = 'Select at least one delivery';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Info', msg);
      return;
    }
    try {
      const res = await api.getUsers({ role: 'delivery_partner', limit: 100 });
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users.filter(u => u.is_active) : []);
    } catch (err) {
      console.error('Fetch partners error:', err);
      setPartners([]);
    }
    setAssignModalVisible(true);
  };

  const filteredDeliveries = search
    ? deliveries.filter(d =>
        (d.sale_number || '').toLowerCase().includes(search.toLowerCase()) ||
        (d.customer_name || '').toLowerCase().includes(search.toLowerCase()) ||
        (d.partner_name || '').toLowerCase().includes(search.toLowerCase())
      )
    : deliveries;

  // Sort by scheduled date+time (earliest first, no-date last)
  const sortedDeliveries = [...filteredDeliveries].sort((a, b) => {
    const dA = (a.scheduled_date || '').split('T')[0];
    const dB = (b.scheduled_date || '').split('T')[0];
    const dtA = dA ? `${dA} ${a.scheduled_time || '00:00'}` : 'zzzz';
    const dtB = dB ? `${dB} ${b.scheduled_time || '00:00'}` : 'zzzz';
    return dtA.localeCompare(dtB);
  });

  // Group by date for section headers
  const getDateLabel = (dateStr) => formatShopDateLabel(dateStr, timezone);


  const sections = [];
  const grouped = {};
  for (const item of sortedDeliveries) {
    const key = (item.scheduled_date || '').split('T')[0] || '_unscheduled';
    if (!grouped[key]) {
      grouped[key] = { title: getDateLabel(key), data: [] };
      sections.push(grouped[key]);
    }
    grouped[key].data.push(item);
  }

  const getTimeInfo = (item) => {
    // For delivered/failed orders, show completion time instead of countdown
    if (item.status === 'delivered' && item.delivered_time) {
      return {
        label: 'Delivered ' + formatDateTime(item.delivered_time, 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }),
        countdown: null,
        isOverdue: false,
        isDone: true,
      };
    }
    if (item.status === 'failed') {
      return { label: 'Failed', countdown: null, isOverdue: false, isDone: true };
    }

    if (!item.scheduled_date) return { label: null, countdown: null, isOverdue: false };
    const dateStr = (item.scheduled_date || '').split('T')[0];
    if (!dateStr) return { label: null, countdown: null, isOverdue: false };
    // PostgreSQL TIME returns HH:MM:SS — only take HH:MM for display
    const rawTime = (item.scheduled_time || '').split('.')[0]; // strip fractional seconds
    const timeStr = rawTime || '00:00';
    // Build ISO string: if timeStr is HH:MM:SS, don't append :00
    const isoTime = timeStr.length <= 5 ? `${timeStr}:00` : timeStr;
    const target = parseServerDate(`${dateStr}T${isoTime}`);

    if (isNaN(target.getTime())) return { label: dateStr, countdown: null, isOverdue: false };
    const diffMs = target - now;
    const diffMin = Math.round(diffMs / 60000);

    const today = getShopTodayStr(timezone);
    const tomorrowStr = getShopTomorrowStr(timezone);

    let dateLabel = '';
    if (dateStr === today) dateLabel = 'Today';
    else if (dateStr === tomorrowStr) dateLabel = 'Tomorrow';
    else {
      dateLabel = target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }


    const formattedTime = rawTime ? target.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const label = formattedTime ? `${dateLabel}, ${formattedTime}` : dateLabel;

    let countdown = null;
    let isOverdue = false;
    if (diffMin < 0) {
      isOverdue = true;
      const overMin = Math.abs(diffMin);
      countdown = overMin >= 60 ? `${Math.floor(overMin / 60)}h ${overMin % 60}m overdue` : `${overMin}m overdue`;
    } else if (diffMin < 1440) {
      countdown = diffMin >= 60 ? `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `in ${diffMin}m`;
    }
    return { label, countdown, isOverdue };
  };

  const renderDelivery = ({ item }) => {
    const statusColor = STATUS_COLORS[item.status] || '#999';
    const isAtRisk = atRiskIds.has(item.id);
    const timeInfo = getTimeInfo(item);
    const canSelect = batchMode && ['pending', 'assigned', 'failed'].includes(item.status);
    const isSelected = selectedIds.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.card, isAtRisk && styles.cardAtRisk, isSelected && styles.cardSelected]}
        onPress={() => {
          if (canSelect) { toggleSelect(item.id); }
          else navigation.navigate('DeliveryDetail', { deliveryId: item.id });
        }}
        onLongPress={() => {
          if (isManager && ['pending', 'assigned', 'failed'].includes(item.status)) {
            setBatchMode(true);
            setSelectedIds(new Set([item.id]));
          }
        }}
      >
        {/* Selection checkbox */}
        {batchMode && canSelect && (
          <View style={styles.selectCheck}>
            <Ionicons name={isSelected ? 'checkbox' : 'square-outline'} size={22} color={isSelected ? Colors.primary : Colors.textLight} />
          </View>
        )}

        {/* Time header — prominent */}
        {timeInfo.label && (
          <View style={[styles.timeHeader, timeInfo.isOverdue && styles.timeHeaderOverdue, timeInfo.isDone && styles.timeHeaderDone]}>
            <View style={styles.timeRow}>
              <Ionicons name={timeInfo.isDone ? 'checkmark-circle' : 'time-outline'} size={18} color={timeInfo.isDone ? Colors.success : timeInfo.isOverdue ? '#D32F2F' : Colors.primary} />
              <Text style={[styles.timeText, timeInfo.isOverdue && styles.timeTextOverdue, timeInfo.isDone && { color: Colors.success }]}>{timeInfo.label}</Text>
            </View>
            {timeInfo.countdown && (
              <Text style={[styles.countdownText, timeInfo.isOverdue ? styles.countdownOverdue : styles.countdownNormal]}>
                {timeInfo.countdown}
              </Text>
            )}
          </View>
        )}

        <View style={styles.cardHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>
            <Text style={styles.orderNum}>
              {item.sale_number}
              {!selectedLocation && item.location_name ? ` • ${item.location_name}` : ''}
            </Text>
            {isAtRisk && (
              <View style={styles.urgentBadge}>
                <Ionicons name="warning" size={10} color="#FF6D00" />
                <Text style={styles.urgentText}>LATE</Text>
              </View>
            )}
          </View>

          <View style={[styles.badge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>
              {item.status.replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        </View>

        <View style={styles.cardBody}>
          <View style={styles.row}>
            <Ionicons name="location-outline" size={16} color={Colors.textLight} />
            <Text style={styles.address} numberOfLines={2}>{item.delivery_address}</Text>
          </View>
          {item.customer_name && (
            <View style={styles.row}>
              <Ionicons name="person-outline" size={16} color={Colors.textLight} />
              <Text style={styles.cardText}>{item.customer_name} {item.customer_phone ? `• ${item.customer_phone}` : ''}</Text>
            </View>
          )}
          {item.partner_name && (
            <View style={styles.row}>
              <Ionicons name="bicycle-outline" size={16} color={Colors.textLight} />
              <Text style={styles.cardText}>{item.partner_name}</Text>
            </View>
          )}
        </View>

        {(item.special_instructions || item.notes) && (
          <Text style={{ fontSize: FontSize.xs, color: '#D32F2F', marginTop: 4, paddingHorizontal: Spacing.md, fontWeight: '600' }}>
            Order Note: {item.special_instructions || item.notes}
          </Text>
        )}
        
        {(item.items && item.items.length > 0) && (
          <View style={{ marginHorizontal: Spacing.md, marginTop: 8, backgroundColor: Colors.background, padding: 8, borderRadius: 6 }}>
            {item.items.map((it, idx) => (
              <View key={idx} style={{ marginBottom: idx === item.items.length - 1 ? 0 : 4 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{it.quantity}x {it.product_name}</Text>
                {it.item_special_instructions ? (
                  <Text style={{ fontSize: FontSize.xs, color: '#F57C00', marginLeft: 8, fontWeight: '500' }}>* {it.item_special_instructions}</Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        <View style={styles.cardFooter}>
          {isManager && <Text style={styles.amount}>₹{Number(item.grand_total || 0).toFixed(0)}</Text>}
          {item.cod_amount > 0 && (
            <View style={[styles.codBadge, item.cod_status === 'collected' ? styles.codCollected : styles.codPending]}>
              <Text style={styles.codText}>
                {!isManager ? 'Collect' : 'COD'} ₹{Number(item.cod_amount).toFixed(0)} {item.cod_status === 'collected' ? '✓' : item.cod_status === 'settled' ? '$$' : ''}
              </Text>
            </View>
          )}
          {!isManager && item.cod_amount === 0 && (
            <View style={[styles.codBadge, styles.codCollected]}>
              <Text style={styles.codText}>Prepaid ✓</Text>
            </View>
          )}
          {isManager && item.status === 'pending' && (
            <TouchableOpacity style={styles.assignBtn} onPress={() => openAssignModal(item)}>
              <Text style={styles.assignBtnText}>Assign</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={Colors.textLight} style={{ marginRight: 6 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by order #, customer, partner..."
          value={search}
          onChangeText={setSearch}
          placeholderTextColor={Colors.textLight}
        />
      </View>

      {/* Status tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsRow}>
        {STATUS_TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, statusFilter === tab.key && styles.tabActive]}
            onPress={() => setStatusFilter(tab.key)}
          >
            <Text style={[styles.tabText, statusFilter === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Location filter */}
      {(locations.length > 0 && isManager) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locationTabsRow}>
          {isOwner && (
            <TouchableOpacity
              style={[styles.locationChip, selectedLocation === null && styles.locationChipActive]}
              onPress={() => setSelectedLocation(null)}
            >
              <Text style={[styles.locationChipText, selectedLocation === null && styles.locationChipTextActive]}>All Locations</Text>
            </TouchableOpacity>
          )}
          {locations.map(loc => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locationChip, selectedLocation === loc.id && styles.locationChipActive]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locationChipText, selectedLocation === loc.id && styles.locationChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Batch mode bar */}
      {isManager && batchMode && (
        <View style={styles.batchBar}>
          <Text style={styles.batchBarText}>{selectedIds.size} selected</Text>
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            <TouchableOpacity style={styles.batchAssignBtn} onPress={openBatchAssignModal}>
              <Ionicons name="people" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign All</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchCancelBtn}
              onPress={() => { setBatchMode(false); setSelectedIds(new Set()); }}
            >
              <Text style={styles.batchCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* List — grouped by date */}
      <SectionList
        sections={sections}
        renderItem={renderDelivery}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHeader}>
            <Ionicons name="calendar-outline" size={16} color={Colors.primary} />
            <Text style={styles.sectionHeaderText}>{title}</Text>
          </View>
        )}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
        refreshing={loading}
        onRefresh={fetchDeliveries}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="bicycle-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No deliveries found</Text>
          </View>
        }
      />

      {/* Assign Modal */}
      <Modal visible={assignModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Assign Delivery Partner</Text>
              <TouchableOpacity onPress={() => setAssignModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            {batchMode ? (
              <Text style={styles.modalSubtitle}>Assign {selectedIds.size} deliveries to a partner</Text>
            ) : selectedDelivery ? (
              <Text style={styles.modalSubtitle}>{selectedDelivery.sale_number} — {selectedDelivery.customer_name || 'Customer'}</Text>
            ) : null}
            <ScrollView style={{ maxHeight: 300 }}>
              {partners.length === 0 ? (
                <Text style={styles.emptyText}>No delivery partners found. Add staff with "delivery_partner" role.</Text>
              ) : (
                partners.map(p => (
                  <TouchableOpacity key={p.id} style={styles.partnerItem} onPress={() => handleAssign(p.id)}>
                    <Ionicons name="person-circle" size={36} color={Colors.primary} />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text style={styles.partnerName}>{p.name}</Text>
                      <Text style={styles.partnerPhone}>{p.phone}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchRow: { flexDirection: 'row', alignItems: 'center', margin: Spacing.md, marginBottom: 0, backgroundColor: Colors.surface, borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  tabsRow: { flexGrow: 0, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: Colors.surface, marginRight: 8, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textLight },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  locationTabsRow: { flexGrow: 0, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginBottom: Spacing.sm },
  locationChip: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20, backgroundColor: Colors.surface, marginRight: 8, borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed' },
  locationChipActive: { backgroundColor: Colors.primary + '15', borderColor: Colors.primary, borderStyle: 'solid' },
  locationChipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  locationChipTextActive: { color: Colors.primary, fontWeight: '700' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.md, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  cardAtRisk: { borderWidth: 2, borderColor: '#FF6D00' },
  timeHeader: { backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.sm, padding: Spacing.sm, marginBottom: Spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timeHeaderOverdue: { backgroundColor: '#FFEBEE' },
  timeHeaderDone: { backgroundColor: '#E8F5E9' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  timeText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  timeTextOverdue: { color: '#D32F2F' },
  countdownText: { fontSize: FontSize.sm, fontWeight: '700' },
  countdownNormal: { color: Colors.primary },
  countdownOverdue: { color: '#D32F2F' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  orderNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700' },
  cardBody: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 6 },
  address: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  cardText: { fontSize: FontSize.sm, color: Colors.textLight },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  codBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  codPending: { backgroundColor: '#FFF3E0' },
  codCollected: { backgroundColor: '#E8F5E9' },
  codText: { fontSize: FontSize.xs, fontWeight: '600', color: '#E65100' },
  assignBtn: { backgroundColor: Colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: BorderRadius.md },
  assignBtnText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 4, marginTop: 8 },
  sectionHeaderText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8, textAlign: 'center' },
  urgentBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FFF3E0', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  urgentText: { fontSize: 8, fontWeight: '800', color: '#FF6D00' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, maxHeight: '70%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: Spacing.md },
  partnerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  partnerName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partnerPhone: { fontSize: FontSize.sm, color: Colors.textLight },
  // Batch mode
  cardSelected: { borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.primary + '08' },
  selectCheck: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 1 },
  batchBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.primary + '15', borderBottomWidth: 1, borderBottomColor: Colors.primary + '30',
  },
  batchBarText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  batchAssignBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
  },
  batchAssignText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  batchCancelBtn: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  batchCancelText: { color: Colors.textSecondary, fontSize: FontSize.sm },
});
