import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDate } from '../utils/datetime';

export default function CustomerOrdersScreen({ navigation }) {
  const [tab, setTab] = useState('orders'); // orders | dues
  const [orders, setOrders] = useState([]);
  const [dues, setDues] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      if (tab === 'orders') {
        const res = await api.getMyOrders();
        setOrders(res.data || []);
      } else {
        const res = await api.getCustomerDues();
        const duesData = res.data?.orders || res.data || [];
        setDues(Array.isArray(duesData) ? duesData : []);
      }
    } catch (err) {
      console.error('Fetch customer data error:', err);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const totalDue = (Array.isArray(dues) ? dues : []).reduce((sum, d) => sum + (d.balance_due || 0), 0);

  const statusColor = (status) => {
    switch (status) {
      case 'completed': return '#4CAF50';
      case 'ready': return '#2196F3';
      case 'preparing': case 'in_production': return '#FF9800';
      case 'pending': return '#9E9E9E';
      default: return '#9E9E9E';
    }
  };

  const renderOrder = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.orderNum}>{item.sale_number}</Text>
          <Text style={styles.cardDate}>{formatDate(item.created_at)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.amount}>₹{(item.grand_total || 0).toFixed(0)}</Text>
          <View style={[styles.badge, { backgroundColor: statusColor(item.status) + '20' }]}>
            <Text style={[styles.badgeText, { color: statusColor(item.status) }]}>
              {(item.status || '').replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        </View>
      </View>

      {/* Order type & delivery info */}
      <View style={[styles.row, { marginTop: 6 }]}>
        <View style={styles.typeBadge}>
          <Ionicons
            name={item.order_type === 'delivery' ? 'bicycle-outline' : item.order_type === 'pickup' ? 'bag-outline' : 'storefront-outline'}
            size={14}
            color={Colors.textLight}
          />
          <Text style={styles.typeText}>{(item.order_type || 'walk_in').replace(/_/g, ' ')}</Text>
        </View>
        {item.payment_status && (
          <View style={[styles.payBadge, { backgroundColor: item.payment_status === 'paid' ? '#E8F5E9' : '#FFF3E0' }]}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: item.payment_status === 'paid' ? '#2E7D32' : '#E65100' }}>
              {item.payment_status === 'paid' ? 'PAID' : item.payment_status === 'partial' ? 'PARTIAL' : 'UNPAID'}
            </Text>
          </View>
        )}
      </View>

      {item.balance_due > 0 && (
        <View style={styles.dueRow}>
          <Ionicons name="alert-circle-outline" size={14} color="#E65100" />
          <Text style={styles.dueText}>Balance Due: ₹{item.balance_due.toFixed(0)}</Text>
        </View>
      )}

      {item.delivery_status && (
        <View style={styles.deliveryRow}>
          <Ionicons name="bicycle" size={14} color={Colors.info} />
          <Text style={styles.deliveryText}>Delivery: {item.delivery_status.replace(/_/g, ' ')}</Text>
        </View>
      )}

      {item.pickup_status && item.order_type === 'pickup' && (
        <View style={styles.deliveryRow}>
          <Ionicons name="bag" size={14} color={Colors.info} />
          <Text style={styles.deliveryText}>Pickup: {item.pickup_status.replace(/_/g, ' ')}</Text>
        </View>
      )}
    </View>
  );

  const renderDue = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.orderNum}>{item.sale_number}</Text>
          <Text style={styles.cardDate}>{formatDate(item.created_at)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.totalLabel}>Due</Text>
          <Text style={[styles.amount, { color: '#E65100' }]}>₹{(item.balance_due || 0).toFixed(0)}</Text>
        </View>
      </View>
      <View style={styles.cardRow}>
        <Text style={styles.cardSub}>Total: ₹{(item.grand_total || 0).toFixed(0)}</Text>
        <Text style={styles.cardSub}>Paid: ₹{(item.total_paid || 0).toFixed(0)}</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity style={[styles.tab, tab === 'orders' && styles.tabActive]} onPress={() => setTab('orders')}>
          <Ionicons name="receipt-outline" size={18} color={tab === 'orders' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'orders' && styles.tabTextActive]}>My Orders</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, tab === 'dues' && styles.tabActive]} onPress={() => setTab('dues')}>
          <Ionicons name="wallet-outline" size={18} color={tab === 'dues' ? '#fff' : Colors.textLight} />
          <Text style={[styles.tabText, tab === 'dues' && styles.tabTextActive]}>My Dues</Text>
        </TouchableOpacity>
      </View>

      {/* Dues Summary */}
      {tab === 'dues' && dues.length > 0 && (
        <View style={styles.summaryCard}>
          <Ionicons name="alert-circle" size={24} color="#E65100" />
          <View style={{ marginLeft: 12 }}>
            <Text style={styles.summaryLabel}>Total Outstanding</Text>
            <Text style={[styles.summaryValue, { color: '#E65100' }]}>₹{totalDue.toFixed(0)}</Text>
          </View>
          <Text style={[styles.cardSub, { marginLeft: 'auto' }]}>{dues.length} order{dues.length > 1 ? 's' : ''}</Text>
        </View>
      )}

      <FlatList
        data={tab === 'orders' ? orders : dues}
        renderItem={tab === 'orders' ? renderOrder : renderDue}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
        refreshing={loading}
        onRefresh={fetchData}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={tab === 'orders' ? 'receipt-outline' : 'wallet-outline'} size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>
              {tab === 'orders' ? 'No orders yet' : 'No outstanding dues!'}
            </Text>
          </View>
        }
      />
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
  summaryCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF3E0', margin: Spacing.md, marginBottom: 0, padding: Spacing.md, borderRadius: BorderRadius.lg },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  summaryValue: { fontSize: FontSize.xl, fontWeight: '700' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  orderNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  cardDate: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  totalLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  cardSub: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 4 },
  badge: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.background, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  typeText: { fontSize: FontSize.xs, color: Colors.textLight, textTransform: 'capitalize' },
  payBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, backgroundColor: '#FFF3E0', padding: 8, borderRadius: 8 },
  dueText: { fontSize: FontSize.sm, fontWeight: '600', color: '#E65100' },
  deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  deliveryText: { fontSize: FontSize.sm, color: Colors.info, textTransform: 'capitalize' },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8 },
});
