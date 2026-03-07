import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee',
  delivery_partner: 'Delivery Partner',
  customer: 'Customer',
};

const ROLE_COLORS = {
  owner: Colors.roleOwner,
  manager: Colors.roleManager,
  employee: Colors.roleEmployee,
  delivery_partner: Colors.roleDelivery,
  customer: Colors.roleCustomer,
};

function QuickAction({ icon, label, color, onPress }) {
  return (
    <TouchableOpacity style={styles.quickAction} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.quickActionIcon, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={24} color={color} />
      </View>
      <Text style={styles.quickActionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatCard({ title, value, icon, color }) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconWrap, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

export default function DashboardScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [locationCount, setLocationCount] = useState(0);

  const role = user?.role;

  const fetchDashboardData = useCallback(async () => {
    try {
      const response = await api.getLocations();
      setLocationCount(response.data?.locations?.length || 0);
    } catch {
      // non-critical
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
    }, [fetchDashboardData])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
    >
      {/* Welcome Header */}
      <View style={styles.welcomeCard}>
        <View style={styles.welcomeRow}>
          <View style={styles.welcomeText}>
            <Text style={styles.greeting}>{getGreeting()}</Text>
            <Text style={styles.userName}>{user?.name}</Text>
          </View>
          <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[role] + '20' }]}>
            <Text style={[styles.roleText, { color: ROLE_COLORS[role] }]}>
              {ROLE_LABELS[role]}
            </Text>
          </View>
        </View>

        {activeLocation && (
          <View style={styles.locationRow}>
            <Ionicons name="location" size={14} color={Colors.primary} />
            <Text style={styles.locationText}>{activeLocation.name}</Text>
          </View>
        )}
      </View>

      {/* Owner/Manager Quick Actions */}
      {(role === 'owner' || role === 'manager') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.quickActions}>
            <QuickAction
              icon="people"
              label="Staff"
              color={Colors.info}
              onPress={() => navigation.navigate('Staff')}
            />
            <QuickAction
              icon="location"
              label="Locations"
              color={Colors.secondary}
              onPress={() => navigation.navigate('Locations')}
            />
            <QuickAction
              icon="settings"
              label="Settings"
              color={Colors.warning}
              onPress={() => navigation.navigate('Profile', { screen: 'Settings' })}
            />
            <QuickAction
              icon="person"
              label="Profile"
              color={Colors.primary}
              onPress={() => navigation.navigate('Profile')}
            />
          </View>
        </View>
      )}

      {/* Stats placeholder */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Overview</Text>
        <View style={styles.statsRow}>
          <StatCard title="Locations" value={locationCount} icon="storefront" color={Colors.secondary} />
          <StatCard title="Role" value={ROLE_LABELS[role]} icon="shield" color={Colors.info} />
        </View>
      </View>

      {/* Coming soon notice */}
      <View style={styles.comingSoon}>
        <Ionicons name="construct-outline" size={32} color={Colors.textLight} />
        <Text style={styles.comingSoonTitle}>More coming soon</Text>
        <Text style={styles.comingSoonText}>
          Inventory, POS, Orders, and Reports will be available in upcoming updates.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },

  welcomeCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  welcomeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  welcomeText: { flex: 1 },
  greeting: { fontSize: FontSize.sm, color: Colors.textSecondary },
  userName: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginTop: 2 },
  roleBadge: { paddingHorizontal: Spacing.sm + 2, paddingVertical: Spacing.xs, borderRadius: BorderRadius.full },
  roleText: { fontSize: FontSize.xs, fontWeight: '600' },
  locationRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: 4 },
  locationText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  section: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.md },

  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  quickAction: { alignItems: 'center', width: 72 },
  quickActionIcon: {
    width: 52,
    height: 52,
    borderRadius: BorderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  quickActionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },

  statsRow: { flexDirection: 'row', gap: Spacing.md },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    alignItems: 'center',
  },
  statIconWrap: { width: 36, height: 36, borderRadius: BorderRadius.md, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  statValue: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  statTitle: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  comingSoon: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
  },
  comingSoonTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  comingSoonText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', marginTop: Spacing.xs },
});
