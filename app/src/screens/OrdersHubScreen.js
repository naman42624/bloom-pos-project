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
      <View style={styles.listContainer}>
        {SECTIONS.map((s, idx) => {
          const isLast = idx === SECTIONS.length - 1;
          return (
            <TouchableOpacity
              key={s.key}
              style={[styles.tile, isLast && { borderBottomWidth: 0 }]}
              onPress={() => navigation.navigate(s.key)}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, { backgroundColor: s.color }]}>
                <Ionicons name={s.icon} size={20} color={Colors.white} />
              </View>
              <Text style={styles.tileLabel}>{s.label}</Text>
              {counts[s.countKey] > 0 && (
                <View style={[styles.badge, { backgroundColor: Colors.surfaceAlt }]}>
                  <Text style={styles.badgeText}>{counts[s.countKey]}</Text>
                </View>
              )}
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} style={{ marginLeft: 8 }} />
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, gap: Spacing.md },
  listContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.03, shadowRadius: 6, elevation: 2,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  iconWrap: {
    width: 34, height: 34, borderRadius: 8,
    justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.md,
  },
  tileLabel: { flex: 1, fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  badge: {
    minWidth: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
});
