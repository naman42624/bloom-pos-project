import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Linking, Modal, TextInput, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function SupplierDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { supplierId } = route.params;
  const [supplier, setSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Link material modal state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [allMaterials, setAllMaterials] = useState([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState(null);
  const [linkPrice, setLinkPrice] = useState('');
  const [linking, setLinking] = useState(false);

  const canManage = user?.role === 'owner' || user?.role === 'manager';

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getSupplier(supplierId);
      setSupplier(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load supplier');
    } finally { setLoading(false); setRefreshing(false); }
  }, [supplierId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const openLinkModal = async () => {
    try {
      const res = await api.getMaterials();
      const linkedIds = (supplier?.materials || []).map((m) => m.material_id || m.id);
      setAllMaterials((res.data || []).filter((m) => !linkedIds.includes(m.id)));
      setSelectedMaterialId(null);
      setLinkPrice('');
      setShowLinkModal(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to load materials');
    }
  };

  const handleLinkMaterial = async () => {
    if (!selectedMaterialId) { Alert.alert('Select', 'Please select a material'); return; }
    setLinking(true);
    try {
      const data = { material_id: selectedMaterialId };
      if (linkPrice && parseFloat(linkPrice) > 0) data.default_price_per_unit = parseFloat(linkPrice);
      await api.linkSupplierMaterial(supplierId, data);
      setShowLinkModal(false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to link material');
    } finally { setLinking(false); }
  };

  const handleUnlinkMaterial = async (materialId, materialName) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove ${materialName} from this supplier?`)
      : await new Promise((resolve) =>
          Alert.alert('Unlink Material', `Remove ${materialName} from this supplier?`, [
            { text: 'Cancel', onPress: () => resolve(false), style: 'cancel' },
            { text: 'Unlink', onPress: () => resolve(true), style: 'destructive' },
          ])
        );
    if (!confirmed) return;
    try {
      await api.unlinkSupplierMaterial(supplierId, materialId);
      fetchData();
    } catch (err) { Alert.alert('Error', err.message || 'Failed to unlink'); }
  };

  const statusColor = (status) => {
    switch (status) {
      case 'received': return Colors.success;
      case 'partially_received': return Colors.warning;
      case 'cancelled': return Colors.error;
      default: return Colors.info;
    }
  };

  if (!supplier && !loading) {
    return <View style={styles.container}><Text style={styles.errorText}>Supplier not found</Text></View>;
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      >
        {supplier && (
          <>
            <View style={styles.header}>
              <View style={[styles.iconBox, { backgroundColor: Colors.info + '15' }]}>
                <Ionicons name="business" size={32} color={Colors.info} />
              </View>
              <Text style={styles.name}>{supplier.name}</Text>
              {supplier.phone && (
                <TouchableOpacity style={styles.phoneRow} onPress={() => Linking.openURL(`tel:${supplier.phone}`)}>
                  <Ionicons name="call" size={16} color={Colors.secondary} />
                  <Text style={styles.phoneText}>{supplier.phone}</Text>
                </TouchableOpacity>
              )}
              {supplier.email && <Text style={styles.email}>{supplier.email}</Text>}
              {supplier.address && <Text style={styles.address}>{supplier.address}</Text>}
              {supplier.gst_number && <Text style={styles.gst}>GST: {supplier.gst_number}</Text>}
              {supplier.notes ? <Text style={styles.notes}>{supplier.notes}</Text> : null}

              {canManage && (
                <TouchableOpacity style={styles.editBtn} onPress={() => navigation.navigate('SupplierForm', { supplier })}>
                  <Ionicons name="pencil" size={16} color={Colors.primary} />
                  <Text style={styles.editText}>Edit Supplier</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Linked materials */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitleInline}>Materials ({supplier.material_count ?? (supplier.materials || []).length})</Text>
              {canManage && (
                <TouchableOpacity onPress={openLinkModal} style={styles.addBtn}>
                  <Ionicons name="add-circle" size={18} color={Colors.primary} />
                  <Text style={styles.addBtnText}>Link</Text>
                </TouchableOpacity>
              )}
            </View>
            {(supplier.materials || []).length === 0 ? (
              <View style={styles.emptySection}><Text style={styles.emptyText}>No materials linked</Text></View>
            ) : (
              supplier.materials.map((m) => (
                <View key={m.id || m.material_id} style={styles.matCard}>
                  <TouchableOpacity
                    style={styles.matInfo}
                    onPress={() => navigation.navigate('MaterialDetail', { materialId: m.material_id || m.id })}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.matName}>{m.material_name}</Text>
                    <Text style={styles.matCat}>{m.category_name} · {m.sku}</Text>
                  </TouchableOpacity>
                  {m.default_price_per_unit > 0 && (
                    <Text style={styles.matPrice}>₹{m.default_price_per_unit}</Text>
                  )}
                  {canManage && (
                    <TouchableOpacity
                      style={styles.unlinkBtn}
                      onPress={() => handleUnlinkMaterial(m.material_id || m.id, m.material_name)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="close-circle" size={20} color={Colors.error} />
                    </TouchableOpacity>
                  )}
                </View>
              ))
            )}

            {/* Recent orders */}
            <Text style={styles.sectionTitle}>Recent Orders ({(supplier.recent_orders || []).length})</Text>
            {(supplier.recent_orders || []).length === 0 ? (
              <View style={styles.emptySection}><Text style={styles.emptyText}>No orders yet</Text></View>
            ) : (
              supplier.recent_orders.map((o) => (
                <TouchableOpacity
                  key={o.id}
                  style={styles.orderCard}
                  onPress={() => navigation.navigate('PurchaseOrderDetail', { orderId: o.id })}
                >
                  <View style={styles.orderInfo}>
                    <Text style={styles.orderNum}>{o.po_number}</Text>
                    <Text style={styles.orderMeta}>{o.location_name} · {new Date(o.created_at).toLocaleDateString()}</Text>
                  </View>
                  <View style={styles.orderRight}>
                    {o.total_amount !== undefined && <Text style={styles.orderAmount}>₹{o.total_amount}</Text>}
                    <View style={[styles.statusBadge, { backgroundColor: statusColor(o.status) + '20' }]}>
                      <Text style={[styles.statusText, { color: statusColor(o.status) }]}>{o.status.replace('_', ' ')}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}
      </ScrollView>

      {/* Link Material Modal */}
      <Modal visible={showLinkModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowLinkModal(false)} />
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Link Material</Text>
              <TouchableOpacity onPress={() => setShowLinkModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>Select Material</Text>
            <ScrollView style={styles.pickerScroll} nestedScrollEnabled>
              {allMaterials.length === 0 ? (
                <Text style={styles.emptyText}>All materials already linked</Text>
              ) : (
                allMaterials.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.pickerItem, selectedMaterialId === m.id && styles.pickerItemActive]}
                    onPress={() => setSelectedMaterialId(m.id)}
                  >
                    <Text style={[styles.pickerItemText, selectedMaterialId === m.id && styles.pickerItemTextActive]}>
                      {m.name}
                    </Text>
                    <Text style={[styles.pickerItemMeta, selectedMaterialId === m.id && styles.pickerItemTextActive]}>
                      {m.category_name} · {m.sku}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <Text style={styles.modalLabel}>Default Price per unit (₹) — optional</Text>
            <TextInput
              style={styles.modalInput}
              value={linkPrice}
              onChangeText={setLinkPrice}
              keyboardType="numeric"
              placeholder="Leave blank to skip"
              placeholderTextColor={Colors.textLight}
            />

            <TouchableOpacity
              style={[styles.linkBtn, (linking || !selectedMaterialId) && { opacity: 0.5 }]}
              onPress={handleLinkMaterial}
              disabled={linking || !selectedMaterialId}
            >
              <Text style={styles.linkBtnText}>{linking ? 'Linking...' : 'Link Material'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  errorText: { textAlign: 'center', marginTop: 40, color: Colors.textSecondary },
  header: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    alignItems: 'center', marginBottom: Spacing.lg,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  iconBox: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  phoneRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xs, gap: 4 },
  phoneText: { color: Colors.secondary, fontWeight: '500' },
  email: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  address: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, textAlign: 'center' },
  gst: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  notes: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.sm, fontStyle: 'italic' },
  editBtn: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: 4 },
  editText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.md, marginBottom: Spacing.sm },
  sectionTitleInline: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addBtnText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  emptySection: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textLight },
  matCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  matInfo: { flex: 1 },
  matName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  matCat: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  matPrice: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary, marginRight: Spacing.sm },
  unlinkBtn: { marginLeft: 4 },
  orderCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  orderInfo: { flex: 1 },
  orderNum: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  orderMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  orderRight: { alignItems: 'flex-end' },
  orderAmount: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: BorderRadius.sm, marginTop: 4 },
  statusText: { fontSize: FontSize.xs, fontWeight: '500', textTransform: 'capitalize' },
  /* Modal styles */
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, paddingBottom: 40, maxHeight: '70%',
  },
  modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  modalLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  pickerScroll: { maxHeight: 200, marginBottom: Spacing.sm },
  pickerItem: {
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, marginBottom: 4,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  pickerItemActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  pickerItemText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '500' },
  pickerItemMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  pickerItemTextActive: { color: Colors.white },
  modalInput: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: FontSize.md, color: Colors.text,
  },
  linkBtn: {
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, alignItems: 'center', marginTop: Spacing.lg,
  },
  linkBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
});
