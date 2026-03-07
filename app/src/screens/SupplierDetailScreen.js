import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Linking,
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

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getSupplier(supplierId);
      setSupplier(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load supplier');
    } finally { setLoading(false); setRefreshing(false); }
  }, [supplierId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

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

            {(user?.role === 'owner' || user?.role === 'manager') && (
              <TouchableOpacity style={styles.editBtn} onPress={() => navigation.navigate('SupplierForm', { supplier })}>
                <Ionicons name="pencil" size={16} color={Colors.primary} />
                <Text style={styles.editText}>Edit Supplier</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Linked materials */}
          <Text style={styles.sectionTitle}>Materials ({(supplier.materials || []).length})</Text>
          {(supplier.materials || []).length === 0 ? (
            <View style={styles.emptySection}><Text style={styles.emptyText}>No materials linked</Text></View>
          ) : (
            supplier.materials.map((m) => (
              <View key={m.id} style={styles.matCard}>
                <View style={styles.matInfo}>
                  <Text style={styles.matName}>{m.material_name}</Text>
                  <Text style={styles.matCat}>{m.category_name} · {m.sku}</Text>
                </View>
                <Text style={styles.matPrice}>₹{m.default_price_per_unit}</Text>
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
                  <Text style={styles.orderAmount}>₹{o.total_amount}</Text>
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
  emptySection: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textLight },
  matCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  matInfo: { flex: 1 },
  matName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  matCat: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  matPrice: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
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
});
