import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert, TextInput, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function SuppliersScreen({ navigation }) {
  const { user } = useAuth();
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSuppliers = useCallback(async () => {
    try {
      const params = {};
      if (search.trim()) params.search = search.trim();
      const res = await api.getSuppliers(params);
      setSuppliers(res.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load suppliers');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useFocusEffect(useCallback(() => { fetchSuppliers(); }, [fetchSuppliers]));

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('SupplierDetail', { supplierId: item.id })}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.iconBox, { backgroundColor: Colors.info + '15' }]}>
          <Ionicons name="business" size={20} color={Colors.info} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardMeta}>{item.material_count} materials linked</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
      </View>
      {(item.phone || item.address) && (
        <View style={styles.cardFooter}>
          {item.phone && (
            <TouchableOpacity style={styles.phoneBadge} onPress={() => Linking.openURL(`tel:${item.phone}`)}>
              <Ionicons name="call-outline" size={14} color={Colors.secondary} />
              <Text style={styles.phoneText}>{item.phone}</Text>
            </TouchableOpacity>
          )}
          {item.address && (
            <View style={styles.addressBadge}>
              <Ionicons name="location-outline" size={14} color={Colors.textSecondary} />
              <Text style={styles.addressText} numberOfLines={1}>{item.address}</Text>
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search suppliers..."
          placeholderTextColor={Colors.textLight}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={fetchSuppliers}
          returnKeyType="search"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textLight} />
          </TouchableOpacity>
        ) : null}
      </View>

      <FlatList
        data={suppliers}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchSuppliers(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="business-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No suppliers yet</Text>
              <Text style={styles.emptyText}>Add your first supplier</Text>
            </View>
          )
        }
      />

      {(user?.role === 'owner' || user?.role === 'manager') && (
        <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('SupplierForm')} activeOpacity={0.8}>
          <Ionicons name="add" size={28} color={Colors.white} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchContainer: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md, marginTop: Spacing.md, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, gap: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  listContent: { padding: Spacing.md, paddingBottom: 100 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 40, height: 40, borderRadius: BorderRadius.md, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  cardInfo: { flex: 1 },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  cardFooter: { marginTop: Spacing.sm, gap: Spacing.xs },
  phoneBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  phoneText: { fontSize: FontSize.xs, color: Colors.secondary, fontWeight: '500' },
  addressBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addressText: { fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1 },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  fab: {
    position: 'absolute', bottom: 20, right: 20, width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
});
