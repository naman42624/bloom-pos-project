import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, Platform, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TXN_CONFIG = {
  purchase: { icon: 'arrow-down-circle', color: Colors.success, label: 'Purchase', sign: '+' },
  usage: { icon: 'arrow-up-circle', color: Colors.warning, label: 'Usage', sign: '-' },
  wastage: { icon: 'trash', color: Colors.error, label: 'Wastage', sign: '-' },
  transfer_in: { icon: 'enter', color: Colors.info, label: 'Transfer In', sign: '+' },
  transfer_out: { icon: 'exit', color: Colors.info, label: 'Transfer Out', sign: '-' },
  adjustment: { icon: 'build', color: Colors.textSecondary, label: 'Adjustment', sign: '~' },
  return: { icon: 'return-up-back', color: Colors.warning, label: 'Return', sign: '+' },
};

export default function MaterialDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { materialId } = route.params;
  const [material, setMaterial] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Link supplier modal state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [allSuppliers, setAllSuppliers] = useState([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState(null);
  const [linkPrice, setLinkPrice] = useState('');
  const [linking, setLinking] = useState(false);

  const canManage = user?.role === 'owner' || user?.role === 'manager';
  const [uploadingImage, setUploadingImage] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [matRes, txnRes] = await Promise.all([
        api.getMaterial(materialId),
        api.getStockTransactions({ material_id: materialId, limit: 30 }),
      ]);
      setMaterial(matRes.data);
      setTransactions(txnRes.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load material');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [materialId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const openLinkModal = async () => {
    try {
      const res = await api.getSuppliers();
      const linkedIds = (material?.suppliers || []).map((s) => s.id);
      setAllSuppliers((res.data || []).filter((s) => !linkedIds.includes(s.id)));
      setSelectedSupplierId(null);
      setLinkPrice('');
      setShowLinkModal(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to load suppliers');
    }
  };

  const handleLinkSupplier = async () => {
    if (!selectedSupplierId) { Alert.alert('Select', 'Please select a supplier'); return; }
    setLinking(true);
    try {
      const data = { material_id: materialId };
      if (linkPrice && parseFloat(linkPrice) > 0) data.default_price_per_unit = parseFloat(linkPrice);
      await api.linkSupplierMaterial(selectedSupplierId, data);
      setShowLinkModal(false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to link supplier');
    } finally { setLinking(false); }
  };

  const handleUnlinkSupplier = async (supplierId, supplierName) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove ${supplierName} from this material?`)
      : await new Promise((resolve) =>
          Alert.alert('Unlink Supplier', `Remove ${supplierName} from this material?`, [
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

  const formatTxnDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };

  if (!material && !loading) {
    return <View style={styles.container}><Text style={styles.errorText}>Material not found</Text></View>;
  }

  const handleUploadMaterialImage = () => {
    const pickFromGallery = async () => {
      try {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow access.'); return; }
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: true });
        if (result.canceled) return;
        setUploadingImage(true);
        await api.uploadMaterialImage(materialId, result.assets[0].uri);
        fetchData();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to upload image');
      } finally { setUploadingImage(false); }
    };

    const takePhoto = async () => {
      try {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow camera access.'); return; }
        const result = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: true });
        if (result.canceled) return;
        setUploadingImage(true);
        await api.uploadMaterialImage(materialId, result.assets[0].uri);
        fetchData();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to upload image');
      } finally { setUploadingImage(false); }
    };

    if (Platform.OS === 'web') {
      pickFromGallery();
    } else {
      Alert.alert('Add Image', 'Choose a source', [
        { text: 'Camera', onPress: takePhoto },
        { text: 'Gallery', onPress: pickFromGallery },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const BASE_URL = Platform.OS === 'web' ? 'http://localhost:3001' : 'http://192.168.29.160:3001';

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      >
        {material && (
          <>
            <View style={styles.header}>
              <TouchableOpacity
                onPress={canManage ? handleUploadMaterialImage : undefined}
                activeOpacity={canManage ? 0.7 : 1}
                disabled={uploadingImage}
              >
                {material.image_url ? (
                  <Image
                    source={{ uri: `${BASE_URL}${material.image_url}` }}
                    style={styles.materialImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.iconBox, { backgroundColor: Colors.secondary + '15' }]}>
                    <Ionicons name={uploadingImage ? 'hourglass' : 'flower'} size={32} color={Colors.secondary} />
                  </View>
                )}
                {canManage && (
                  <View style={styles.cameraOverlay}>
                    <Ionicons name="camera" size={14} color={Colors.white} />
                  </View>
                )}
              </TouchableOpacity>
              <Text style={styles.name}>{material.name}</Text>
              <Text style={styles.sku}>SKU: {material.sku}</Text>
              <View style={styles.metaRow}>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>Category</Text>
                  <Text style={styles.metaValue}>{material.category_name}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>Unit</Text>
                  <Text style={styles.metaValue}>{material.category_unit}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>Min Alert</Text>
                  <Text style={styles.metaValue}>{material.min_stock_alert}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>Selling Price</Text>
                  <Text style={[styles.metaValue, { color: Colors.success }]}>₹{(material.selling_price || 0).toFixed(2)}</Text>
                </View>
              </View>
              {canManage && (
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => navigation.navigate('MaterialForm', { material })}
                >
                  <Ionicons name="pencil" size={16} color={Colors.primary} />
                  <Text style={styles.editText}>Edit Material</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Stock by location */}
            <Text style={styles.sectionTitle}>Stock by Location</Text>
            {(material.stock || []).length === 0 ? (
              <View style={styles.emptySection}><Text style={styles.emptyText}>No stock recorded</Text></View>
            ) : (
              material.stock.map((s) => (
                <View key={s.id} style={styles.stockCard}>
                  <View style={styles.stockInfo}>
                    <Text style={styles.stockLocation}>{s.location_name}</Text>
                    <Text style={styles.stockDate}>
                      {s.last_counted_at ? `Counted: ${new Date(s.last_counted_at).toLocaleDateString()}` : 'Never counted'}
                    </Text>
                  </View>
                  <Text style={[styles.stockQty, { color: s.quantity < material.min_stock_alert ? Colors.error : Colors.success }]}>
                    {s.quantity} {material.category_unit}
                  </Text>
                </View>
              ))
            )}

            {/* Suppliers */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitleInline}>Suppliers ({(material.suppliers || []).length})</Text>
              {canManage && (
                <TouchableOpacity onPress={openLinkModal} style={styles.addBtn}>
                  <Ionicons name="add-circle" size={18} color={Colors.primary} />
                  <Text style={styles.addBtnText}>Link</Text>
                </TouchableOpacity>
              )}
            </View>
            {(material.suppliers || []).length === 0 ? (
              <View style={styles.emptySection}><Text style={styles.emptyText}>No suppliers linked</Text></View>
            ) : (
              material.suppliers.map((s) => (
                <View key={s.id} style={styles.supplierCard}>
                  <View style={styles.supplierInfo}>
                    <Text style={styles.supplierName}>{s.name}</Text>
                    {s.phone ? <Text style={styles.supplierPhone}>{s.phone}</Text> : null}
                  </View>
                  {s.default_price_per_unit > 0 && (
                    <Text style={styles.supplierPrice}>₹{s.default_price_per_unit}/{material.category_unit}</Text>
                  )}
                  {canManage && (
                    <TouchableOpacity
                      style={styles.unlinkBtn}
                      onPress={() => handleUnlinkSupplier(s.id, s.name)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="close-circle" size={20} color={Colors.error} />
                    </TouchableOpacity>
                  )}
                </View>
              ))
            )}

            {/* Stock Activity / Transaction History */}
            <Text style={styles.sectionTitle}>Stock Activity</Text>
            {transactions.length === 0 ? (
              <View style={styles.emptySection}><Text style={styles.emptyText}>No stock activity recorded</Text></View>
            ) : (
              transactions.map((txn) => {
                const cfg = TXN_CONFIG[txn.type] || { icon: 'ellipse', color: Colors.textSecondary, label: txn.type, sign: '' };
                const isPositive = ['purchase', 'transfer_in', 'return'].includes(txn.type);
                return (
                  <View key={txn.id} style={styles.txnCard}>
                    <View style={[styles.txnIcon, { backgroundColor: cfg.color + '15' }]}>
                      <Ionicons name={cfg.icon} size={18} color={cfg.color} />
                    </View>
                    <View style={styles.txnInfo}>
                      <Text style={styles.txnType}>{cfg.label}</Text>
                      <Text style={styles.txnMeta}>{txn.location_name} · {formatTxnDate(txn.created_at)}</Text>
                      {txn.notes ? <Text style={styles.txnNotes}>{txn.notes}</Text> : null}
                      {txn.created_by_name ? <Text style={styles.txnUser}>by {txn.created_by_name}</Text> : null}
                    </View>
                    <Text style={[styles.txnQty, { color: isPositive ? Colors.success : Colors.error }]}>
                      {isPositive ? '+' : '-'}{txn.quantity} {txn.unit || material.category_unit}
                    </Text>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>

      {/* Link Supplier Modal */}
      <Modal visible={showLinkModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowLinkModal(false)} />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Link Supplier</Text>
              <TouchableOpacity onPress={() => setShowLinkModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>Select Supplier</Text>
            <ScrollView style={styles.pickerScroll} nestedScrollEnabled>
              {allSuppliers.length === 0 ? (
                <Text style={styles.emptyText}>All suppliers already linked</Text>
              ) : (
                allSuppliers.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.pickerItem, selectedSupplierId === s.id && styles.pickerItemActive]}
                    onPress={() => setSelectedSupplierId(s.id)}
                  >
                    <Text style={[styles.pickerItemText, selectedSupplierId === s.id && styles.pickerItemTextActive]}>
                      {s.name}
                    </Text>
                    {s.phone ? (
                      <Text style={[styles.pickerItemMeta, selectedSupplierId === s.id && styles.pickerItemTextActive]}>
                        {s.phone}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <Text style={styles.modalLabel}>Default Price per {material?.category_unit || 'unit'} (₹) — optional</Text>
            <TextInput
              style={styles.modalInput}
              value={linkPrice}
              onChangeText={setLinkPrice}
              keyboardType="numeric"
              placeholder="Leave blank to skip"
              placeholderTextColor={Colors.textLight}
            />

            <TouchableOpacity
              style={[styles.linkBtn, (linking || !selectedSupplierId) && { opacity: 0.5 }]}
              onPress={handleLinkSupplier}
              disabled={linking || !selectedSupplierId}
            >
              <Text style={styles.linkBtnText}>{linking ? 'Linking...' : 'Link Supplier'}</Text>
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
  materialImage: { width: 80, height: 80, borderRadius: 40, marginBottom: Spacing.sm },
  cameraOverlay: {
    position: 'absolute', bottom: Spacing.sm, right: -2, backgroundColor: Colors.primary,
    width: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: Colors.surface,
  },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  sku: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.md, gap: Spacing.lg },
  metaItem: { alignItems: 'center' },
  metaLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  metaValue: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: 2 },
  editBtn: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: 4 },
  editText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.md, marginBottom: Spacing.sm },
  sectionTitleInline: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addBtnText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  emptySection: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textLight },
  stockCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  stockInfo: { flex: 1 },
  stockLocation: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  stockDate: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  stockQty: { fontSize: FontSize.lg, fontWeight: '700' },
  supplierCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  supplierInfo: { flex: 1 },
  supplierName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  supplierPhone: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  supplierPrice: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary, marginRight: Spacing.sm },
  unlinkBtn: { marginLeft: 4 },
  /* Transaction history */
  txnCard: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  txnIcon: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.sm,
  },
  txnInfo: { flex: 1 },
  txnType: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  txnMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  txnNotes: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2, fontStyle: 'italic' },
  txnUser: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  txnQty: { fontSize: FontSize.md, fontWeight: '700', marginLeft: Spacing.sm },
  /* Modal styles */
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, paddingBottom: 40, maxHeight: '70%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
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
