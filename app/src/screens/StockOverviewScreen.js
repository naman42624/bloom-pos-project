import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const QUICK_LINKS = [
  { label: 'Categories', icon: 'folder-open', screen: 'Categories', color: '#9C27B0' },
  { label: 'Materials', icon: 'cube', screen: 'Materials', color: Colors.primary },
  { label: 'Products', icon: 'gift', screen: 'Products', color: '#4CAF50' },
  { label: 'Product Stock', icon: 'layers', screen: 'ProductStock', color: '#3F51B5' },
  { label: 'Suppliers', icon: 'people', screen: 'Suppliers', color: '#FF9800' },
  { label: 'Orders', icon: 'cart', screen: 'PurchaseOrders', color: '#2196F3' },
  { label: 'Scan QR', icon: 'qr-code', screen: 'QRScanner', color: '#00BCD4' },
  { label: 'Adjust', icon: 'build', screen: 'StockAdjust', color: '#F44336' },
  { label: 'Transfers', icon: 'swap-horizontal', screen: 'StockTransfers', color: '#009688' },
];

export default function StockOverviewScreen({ navigation }) {
  const [stock, setStock] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const params = {};
      if (selectedLocation) params.location_id = selectedLocation;

      const [stockRes, locRes] = await Promise.all([
        api.getStock(params),
        api.getLocations(),
      ]);
      setStock(stockRes.data || []);
      setLocations(locRes.data?.locations || locRes.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load stock');
    } finally { setLoading(false); setRefreshing(false); }
  }, [selectedLocation]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const renderItem = ({ item }) => {
    const isLow = item.quantity < item.min_stock_alert;
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('MaterialDetail', { materialId: item.material_id })}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.iconBox, { backgroundColor: isLow ? Colors.errorLight : Colors.successLight }]}>
            <Ionicons name={isLow ? 'alert' : 'cube'} size={20} color={isLow ? Colors.error : Colors.success} />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardName}>{item.material_name}</Text>
            <Text style={styles.cardMeta}>{item.category_name} · {item.location_name}</Text>
          </View>
          <View style={styles.qtyBox}>
            <Text style={[styles.qtyText, { color: isLow ? Colors.error : Colors.success }]}>
              {item.quantity}
            </Text>
            <Text style={styles.unitText}>{item.unit}</Text>
          </View>
        </View>
        {isLow && (
          <View style={styles.alertRow}>
            <Ionicons name="warning" size={14} color={Colors.error} />
            <Text style={styles.alertText}>Below minimum ({item.min_stock_alert})</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const ListHeader = () => (
    <View>
      {/* Quick links grid */}
      <View style={styles.quickGrid}>
        {QUICK_LINKS.map((link) => (
          <TouchableOpacity
            key={link.screen}
            style={styles.quickItem}
            onPress={() => navigation.navigate(link.screen)}
            activeOpacity={0.7}
          >
            <View style={[styles.quickIcon, { backgroundColor: link.color + '18' }]}>
              <Ionicons name={link.icon} size={22} color={link.color} />
            </View>
            <Text style={styles.quickLabel}>{link.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Location filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipList}
      >
        {[{ id: null, name: 'All Locations' }, ...locations].map((loc) => (
          <TouchableOpacity
            key={String(loc.id ?? 'all')}
            style={[styles.chip, selectedLocation === loc.id && styles.chipActive]}
            onPress={() => setSelectedLocation(loc.id)}
          >
            <Text style={[styles.chipText, selectedLocation === loc.id && styles.chipTextActive]}>{loc.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Section header */}
      <Text style={styles.sectionTitle}>Stock Levels</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={stock}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="cube-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No stock data</Text>
              <Text style={styles.emptyText}>Stock will appear after receiving purchases</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  quickGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  quickItem: {
    width: '30%', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  quickIcon: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xs,
  },
  quickLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  chipList: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  sectionTitle: {
    fontSize: FontSize.md, fontWeight: '700', color: Colors.text,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
  },
  listContent: { paddingBottom: 100 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 40, height: 40, borderRadius: BorderRadius.md, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  cardInfo: { flex: 1 },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  qtyBox: { alignItems: 'center' },
  qtyText: { fontSize: FontSize.xl, fontWeight: '700' },
  unitText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  alertRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: 4 },
  alertText: { fontSize: FontSize.xs, color: Colors.error, fontWeight: '500' },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
});
