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

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee',
  delivery_partner: 'Delivery',
  customer: 'Customer',
};

const ROLE_COLORS = {
  owner: Colors.roleOwner,
  manager: Colors.roleManager,
  employee: Colors.roleEmployee,
  delivery_partner: Colors.roleDelivery,
  customer: Colors.roleCustomer,
};

const FILTER_ROLES = [
  { key: 'all', label: 'All' },
  { key: 'manager', label: 'Managers' },
  { key: 'employee', label: 'Employees' },
  { key: 'delivery_partner', label: 'Delivery' },
];

export default function UsersScreen({ navigation }) {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [roleFilter, setRoleFilter] = useState('all');

  const fetchUsers = useCallback(async () => {
    try {
      const params = {};
      if (roleFilter !== 'all') params.role = roleFilter;
      const response = await api.getUsers(params);
      setUsers(response.data?.users || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load users');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [roleFilter]);

  useFocusEffect(
    useCallback(() => {
      fetchUsers();
    }, [fetchUsers])
  );

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('UserForm', { user: item })}
      activeOpacity={0.7}
    >
      <View style={styles.cardRow}>
        <View style={[styles.avatar, { backgroundColor: (ROLE_COLORS[item.role] || Colors.textLight) + '20' }]}>
          <Text style={[styles.avatarText, { color: ROLE_COLORS[item.role] || Colors.textLight }]}>
            {item.name?.[0]?.toUpperCase()}
          </Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardPhone}>{item.phone}</Text>
        </View>
        <View style={styles.cardRight}>
          <View style={[styles.roleBadge, { backgroundColor: (ROLE_COLORS[item.role] || Colors.textLight) + '15' }]}>
            <Text style={[styles.roleLabel, { color: ROLE_COLORS[item.role] || Colors.textLight }]}>
              {ROLE_LABELS[item.role]}
            </Text>
          </View>
          {!item.is_active && <Text style={styles.inactiveLabel}>Inactive</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Filter chips */}
      <View style={styles.filterRow}>
        <FlatList
          data={FILTER_ROLES}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.filterContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.filterChip, roleFilter === item.key && styles.filterChipActive]}
              onPress={() => setRoleFilter(item.key)}
            >
              <Text style={[styles.filterText, roleFilter === item.key && styles.filterTextActive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      <FlatList
        data={users}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchUsers(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No staff found</Text>
              <Text style={styles.emptyText}>Add your first team member</Text>
            </View>
          )
        }
      />

      {(user?.role === 'owner' || user?.role === 'manager') && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('UserForm')}
          activeOpacity={0.8}
        >
          <Ionicons name="person-add" size={24} color={Colors.white} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: Spacing.md, paddingBottom: 100 },

  filterRow: { paddingTop: Spacing.sm },
  filterContent: { paddingHorizontal: Spacing.md, gap: Spacing.sm },
  filterChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  filterTextActive: { color: Colors.white },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: '600' },
  cardInfo: { flex: 1 },
  cardName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  cardPhone: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  cardRight: { alignItems: 'flex-end' },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full },
  roleLabel: { fontSize: FontSize.xs, fontWeight: '600' },
  inactiveLabel: { fontSize: FontSize.xs, color: Colors.error, marginTop: 4 },

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
