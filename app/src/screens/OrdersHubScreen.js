import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const SECTIONS = [
  { key: 'SalesList', icon: 'receipt', label: 'All Sales', color: Colors.primary, countKey: 'salesCount' },
  { key: 'DeliveriesList', icon: 'bicycle', label: 'Deliveries', color: '#FF9800', countKey: 'deliveriesCount' },
  { key: 'PickupOrders', icon: 'bag-handle', label: 'Pickups', color: '#4CAF50', countKey: 'pickupsCount' },
  { key: 'ProductionQueue', icon: 'construct', label: 'Production', color: '#9C27B0', countKey: 'productionCount' },
];

export default function OrdersHubScreen({ navigation }) {
  const [counts, setCounts] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const fetchCounts = useCallback(async () => {
    try {
      const [salesRes, deliveriesRes, pickupsRes] = await Promise.all([
        api.getSales({ limit: 1 }).catch(() => ({ data: {} })),
        api.getDeliveries({ status: 'pending' }).catch(() => ({ data: { deliveries: [] } })),
        api.getSales({ order_type: 'pickup', pickup_status: 'waiting', limit: 1 }).catch(() => ({ data: {} })),
      ]);
      setCounts({
        salesCount: salesRes.data?.pagination?.total || 0,
        deliveriesCount: deliveriesRes.data?.deliveries?.length || 0,
        pickupsCount: pickupsRes.data?.pagination?.total || 0,
      });
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchCounts(); }, [fetchCounts]));

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchCounts(); }} colors={[Colors.primary]} />}
    >
      <View style={styles.grid}>
        {SECTIONS.map(s => (
          <TouchableOpacity
            key={s.key}
            style={styles.tile}
            onPress={() => navigation.navigate(s.key)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrap, { backgroundColor: s.color + '15' }]}>
              <Ionicons name={s.icon} size={28} color={s.color} />
            </View>
            <Text style={styles.tileLabel}>{s.label}</Text>
            {counts[s.countKey] > 0 && (
              <View style={[styles.badge, { backgroundColor: s.color }]}>
                <Text style={styles.badgeText}>{counts[s.countKey]}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  tile: {
    width: '47%',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    position: 'relative',
  },
  iconWrap: {
    width: 56, height: 56, borderRadius: 28,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  tileLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, textAlign: 'center' },
  badge: {
    position: 'absolute', top: 8, right: 8,
    minWidth: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.white },
});
