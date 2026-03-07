import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function LocationsScreen({ navigation }) {
  const { user } = useAuth();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchLocations = useCallback(async () => {
    try {
      const response = await api.getLocations();
      setLocations(response.data?.locations || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load locations');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [fetchLocations])
  );

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('LocationDetail', { locationId: item.id })}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.typeIcon, { backgroundColor: item.type === 'shop' ? Colors.primary + '15' : Colors.warning + '15' }]}>
          <Ionicons
            name={item.type === 'shop' ? 'storefront' : 'cube'}
            size={20}
            color={item.type === 'shop' ? Colors.primary : Colors.warning}
          />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardType}>{item.type === 'shop' ? 'Shop' : 'Warehouse'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
      </View>

      {item.address && (
        <View style={styles.addressRow}>
          <Ionicons name="location-outline" size={14} color={Colors.textSecondary} />
          <Text style={styles.addressText} numberOfLines={1}>{item.address}</Text>
        </View>
      )}

      <View style={styles.cardFooter}>
        <View style={styles.staffBadge}>
          <Ionicons name="people-outline" size={14} color={Colors.info} />
          <Text style={styles.staffCount}>{item.staff_count || 0} staff</Text>
        </View>
        {item.phone && (
          <View style={styles.phoneBadge}>
            <Ionicons name="call-outline" size={14} color={Colors.secondary} />
            <Text style={styles.phoneText}>{item.phone}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={locations}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchLocations(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="location-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No locations yet</Text>
              <Text style={styles.emptyText}>Add your first shop or warehouse</Text>
            </View>
          )
        }
      />

      {user?.role === 'owner' && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('LocationForm')}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color={Colors.white} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: Spacing.md, paddingBottom: 100 },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  typeIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  cardInfo: { flex: 1 },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardType: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  addressRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: 4 },
  addressText: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },

  cardFooter: { flexDirection: 'row', marginTop: Spacing.sm, gap: Spacing.md },
  staffBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  staffCount: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '500' },
  phoneBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  phoneText: { fontSize: FontSize.xs, color: Colors.secondary, fontWeight: '500' },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },

  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
});
