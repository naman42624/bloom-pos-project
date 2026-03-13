import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, Platform, Image, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TYPE_LABELS = {
  standard: 'Standard',
  custom: 'Custom',
  made_to_order: 'Made to Order',
};

const TYPE_COLORS = {
  standard: Colors.info,
  custom: Colors.warning,
  made_to_order: '#9C27B0',
};

export default function ProductDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { productId } = route.params;
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Add material modal state
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [allMaterials, setAllMaterials] = useState([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState(null);
  const [materialQty, setMaterialQty] = useState('1');
  const [materialCost, setMaterialCost] = useState('0');
  const [addingMaterial, setAddingMaterial] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  const canManage = user?.role === 'owner' || user?.role === 'manager';

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getProduct(productId);
      setProduct(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load product');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [productId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const confirmDelete = () => {
    const doDelete = async () => {
      try {
        await api.deleteProduct(productId);
        navigation.goBack();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to delete product');
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm('Deactivate this product?')) doDelete();
    } else {
      Alert.alert('Confirm', 'Deactivate this product?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deactivate', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  const openAddMaterial = async () => {
    try {
      const res = await api.getMaterials();
      const linkedIds = (product?.materials || []).map((m) => m.material_id);
      setAllMaterials((res.data || []).filter((m) => !linkedIds.includes(m.id)));
      setSelectedMaterialId(null);
      setMaterialQty('1');
      setMaterialCost('0');
      setShowAddMaterial(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to load materials');
    }
  };

  const handleAddMaterial = async () => {
    if (!selectedMaterialId) { Alert.alert('Select', 'Please select a material'); return; }
    const qty = parseFloat(materialQty);
    if (!qty || qty <= 0) { Alert.alert('Error', 'Quantity must be > 0'); return; }

    setAddingMaterial(true);
    try {
      await api.addProductMaterial(productId, {
        material_id: selectedMaterialId,
        quantity: qty,
        cost_per_unit: parseFloat(materialCost) || 0,
      });
      setShowAddMaterial(false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add material');
    } finally {
      setAddingMaterial(false);
    }
  };

  const confirmRemoveMaterial = (matId, matName) => {
    const doRemove = async () => {
      try {
        await api.removeProductMaterial(productId, matId);
        fetchData();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to remove material');
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Remove ${matName} from this product?`)) doRemove();
    } else {
      Alert.alert('Remove Material', `Remove ${matName}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  if (loading || !product) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="gift-outline" size={48} color={Colors.textLight} />
        <Text style={{ color: Colors.textLight, marginTop: Spacing.sm }}>Loading...</Text>
      </View>
    );
  }

  const margin = (product.selling_price || 0) - (product.estimated_cost || 0);
  const marginPct = product.selling_price ? ((margin / product.selling_price) * 100).toFixed(1) : '0';

  const pickAndUploadImage = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsEditing: true,
      });
      if (result.canceled) return;

      setUploadingImage(true);
      await api.uploadProductImage(productId, result.assets[0].uri, false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const takeAndUploadPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow camera access.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
        allowsEditing: true,
      });
      if (result.canceled) return;

      setUploadingImage(true);
      await api.uploadProductImage(productId, result.assets[0].uri, false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleUploadImage = () => {
    if (Platform.OS === 'web') {
      pickAndUploadImage();
    } else {
      Alert.alert('Add Image', 'Choose a source', [
        { text: 'Camera', onPress: takeAndUploadPhoto },
        { text: 'Gallery', onPress: pickAndUploadImage },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const confirmDeleteImage = (imageId) => {
    const doDelete = async () => {
      try {
        await api.deleteProductImage(productId, imageId);
        fetchData();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to delete image');
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Delete this image?')) doDelete();
    } else {
      Alert.alert('Delete Image', 'Remove this image?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      >
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={[styles.typeTag, { backgroundColor: (TYPE_COLORS[product.type] || Colors.info) + '18' }]}>
              <Text style={[styles.typeTagText, { color: TYPE_COLORS[product.type] || Colors.info }]}>
                {TYPE_LABELS[product.type] || product.type}
              </Text>
            </View>
            {canManage && (
              <View style={styles.headerActions}>
                <TouchableOpacity onPress={() => navigation.navigate('QRLabel', { productId: product.id })} style={styles.actionBtn}>
                  <Ionicons name="qr-code" size={20} color={Colors.info} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => navigation.navigate('ProductForm', { product })} style={styles.actionBtn}>
                  <Ionicons name="create-outline" size={20} color={Colors.primary} />
                </TouchableOpacity>
                {user?.role === 'owner' && (
                  <TouchableOpacity onPress={confirmDelete} style={styles.actionBtn}>
                    <Ionicons name="trash-outline" size={20} color={Colors.error} />
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productSku}>SKU: {product.sku}</Text>
          {product.category && <Text style={styles.productDesc}>Category: {product.category.replace('_', ' ')}</Text>}
          {product.location_name && <Text style={styles.productDesc}>Location: {product.location_name}</Text>}
          {product.description ? <Text style={styles.productDesc}>{product.description}</Text> : null}
        </View>

        {/* Pricing card */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Pricing</Text>
          <View style={styles.priceGrid}>
            <View style={styles.priceBox}>
              <Text style={styles.priceBoxLabel}>Estimated Cost</Text>
              <Text style={styles.priceBoxValue}>₹{(product.estimated_cost || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.priceBox}>
              <Text style={styles.priceBoxLabel}>Selling Price</Text>
              <Text style={[styles.priceBoxValue, { color: Colors.success }]}>₹{(product.selling_price || 0).toFixed(2)}</Text>
            </View>
            {canManage && (
              <View style={styles.priceBox}>
                <Text style={styles.priceBoxLabel}>Margin</Text>
                <Text style={[styles.priceBoxValue, { color: margin >= 0 ? Colors.success : Colors.error }]}>
                  ₹{margin.toFixed(2)} ({marginPct}%)
                </Text>
              </View>
            )}
            {product.tax_percentage > 0 && (
              <View style={styles.priceBox}>
                <Text style={styles.priceBoxLabel}>Tax</Text>
                <Text style={styles.priceBoxValue}>{product.tax_name} ({product.tax_percentage}%)</Text>
              </View>
            )}
          </View>
        </View>

        {/* Materials (Bill of Materials) */}
        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Materials Used</Text>
            {canManage && (
              <TouchableOpacity onPress={openAddMaterial} style={styles.addBtn}>
                <Ionicons name="add-circle" size={24} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {(product.materials || []).length === 0 ? (
            <Text style={styles.emptyText}>No materials linked yet</Text>
          ) : (
            product.materials.map((mat) => {
              const unitCost = mat.cost_per_unit > 0 ? mat.cost_per_unit : mat.supplier_avg_cost || 0;
              return (
                <View key={mat.material_id} style={styles.matRow}>
                  <View style={[styles.matIcon, { backgroundColor: Colors.secondary + '15' }]}>
                    <Ionicons name="flower" size={16} color={Colors.secondary} />
                  </View>
                  <View style={styles.matInfo}>
                    <Text style={styles.matName}>{mat.material_name}</Text>
                    <Text style={styles.matDetail}>
                      {mat.quantity} {mat.unit} × ₹{unitCost.toFixed(2)} = ₹{(mat.quantity * unitCost).toFixed(2)}
                    </Text>
                  </View>
                  {canManage && (
                    <TouchableOpacity onPress={() => confirmRemoveMaterial(mat.material_id, mat.material_name)}>
                      <Ionicons name="close-circle" size={22} color={Colors.error} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })
          )}
        </View>

        {/* Images */}
        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Images</Text>
            {canManage && (
              <TouchableOpacity onPress={handleUploadImage} style={styles.addBtn} disabled={uploadingImage}>
                <Ionicons name={uploadingImage ? 'hourglass' : 'camera'} size={22} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {(product.images || []).length === 0 ? (
            <Text style={styles.emptyText}>No images yet. Tap the camera icon to add.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.sm }}>
              {product.images.map((img) => (
                <TouchableOpacity key={img.id} style={styles.imageThumb} onLongPress={() => canManage && confirmDeleteImage(img.id)} activeOpacity={0.8}>
                  <Image
                    source={{ uri: `${Platform.OS === 'web' ? 'http://localhost:3001' : 'https://api.gifttojalandhar.com'}${img.image_url}` }}
                    style={styles.thumbImg}
                    resizeMode="cover"
                  />
                  {img.is_primary === 1 && (
                    <View style={styles.primaryBadge}>
                      <Text style={styles.primaryBadgeText}>Primary</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      </ScrollView>

      {/* Add Material Modal */}
      <Modal visible={showAddMaterial} transparent animationType="slide" onRequestClose={() => setShowAddMaterial(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Material</Text>
              <TouchableOpacity onPress={() => setShowAddMaterial(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Material</Text>
            <ScrollView style={styles.supplierList} nestedScrollEnabled>
              {allMaterials.length === 0 ? (
                <Text style={styles.emptyText}>All materials already linked</Text>
              ) : (
                allMaterials.map((mat) => (
                  <TouchableOpacity
                    key={mat.id}
                    style={[styles.supplierItem, selectedMaterialId === mat.id && styles.supplierItemActive]}
                    onPress={() => setSelectedMaterialId(mat.id)}
                  >
                    <Text style={[styles.supplierItemText, selectedMaterialId === mat.id && { color: Colors.white }]}>
                      {mat.name} ({mat.category_name})
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <Text style={[styles.fieldLabel, { marginTop: Spacing.md }]}>Quantity</Text>
            <TextInput
              style={styles.modalInput}
              value={materialQty}
              onChangeText={setMaterialQty}
              keyboardType="decimal-pad"
              placeholder="e.g. 5"
              placeholderTextColor={Colors.textLight}
            />

            <Text style={[styles.fieldLabel, { marginTop: Spacing.md }]}>Cost per Unit (₹)</Text>
            <TextInput
              style={styles.modalInput}
              value={materialCost}
              onChangeText={setMaterialCost}
              keyboardType="decimal-pad"
              placeholder="e.g. 25.00"
              placeholderTextColor={Colors.textLight}
            />

            <TouchableOpacity
              style={[styles.modalBtn, addingMaterial && { opacity: 0.6 }]}
              onPress={handleAddMaterial}
              disabled={addingMaterial}
            >
              <Text style={styles.modalBtnText}>{addingMaterial ? 'Adding...' : 'Add Material'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { padding: Spacing.md, paddingBottom: 40 },

  headerCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  typeTag: { paddingHorizontal: Spacing.sm, paddingVertical: 3, borderRadius: BorderRadius.sm },
  typeTagText: { fontSize: FontSize.xs, fontWeight: '600' },
  headerActions: { flexDirection: 'row', gap: Spacing.sm },
  actionBtn: { padding: 6 },
  productName: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  productSku: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  productDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm, lineHeight: 20 },

  sectionCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  addBtn: { padding: 2 },

  priceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  priceBox: { minWidth: '45%' },
  priceBoxLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  priceBoxValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: 2 },

  matRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  matIcon: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.sm },
  matInfo: { flex: 1 },
  matName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  matDetail: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },

  imageThumb: { width: 120, height: 120, borderRadius: BorderRadius.md, overflow: 'hidden', position: 'relative' },
  thumbImg: { width: '100%', height: '100%' },
  primaryBadge: {
    position: 'absolute', bottom: 4, left: 4, backgroundColor: Colors.primary,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: BorderRadius.sm,
  },
  primaryBadgeText: { color: Colors.white, fontSize: 10, fontWeight: '600' },

  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.md },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  supplierList: { maxHeight: 200, marginBottom: Spacing.sm },
  supplierItem: {
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.xs,
  },
  supplierItemActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  supplierItemText: { fontSize: FontSize.sm, color: Colors.text },
  modalInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, fontSize: FontSize.md,
    color: Colors.text, backgroundColor: Colors.background,
  },
  modalBtn: {
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, alignItems: 'center', marginTop: Spacing.lg,
  },
  modalBtnText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
});
