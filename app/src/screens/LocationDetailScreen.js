import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ROLE_COLORS = {
  owner: Colors.roleOwner,
  manager: Colors.roleManager,
  employee: Colors.roleEmployee,
  delivery_partner: Colors.roleDelivery,
  customer: Colors.roleCustomer,
};

export default function LocationDetailScreen({ route, navigation }) {
  const { locationId } = route.params;
  const { user } = useAuth();
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchLocation = useCallback(async () => {
    try {
      const response = await api.getLocation(locationId);
      const loc = response.data?.location || null;
      // Staff is returned as a sibling of location in the response
      if (loc && response.data?.staff) {
        loc.staff = response.data.staff;
      }
      setLocation(loc);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load location');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [locationId, navigation]);

  useFocusEffect(
    useCallback(() => {
      fetchLocation();
    }, [fetchLocation])
  );

  if (loading || !location) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={fetchLocation} colors={[Colors.primary]} />}
    >
      {/* Header Card */}
      <View style={styles.headerCard}>
        <View style={[styles.typeChip, { backgroundColor: location.type === 'shop' ? Colors.primary + '15' : Colors.warning + '15' }]}>
          <Ionicons
            name={location.type === 'shop' ? 'storefront' : 'cube'}
            size={16}
            color={location.type === 'shop' ? Colors.primary : Colors.warning}
          />
          <Text style={[styles.typeText, { color: location.type === 'shop' ? Colors.primary : Colors.warning }]}>
            {location.type === 'shop' ? 'Shop' : 'Warehouse'}
          </Text>
        </View>
        <Text style={styles.name}>{location.name}</Text>

        {user?.role === 'owner' && (
          <TouchableOpacity
            style={styles.editButton}
            onPress={() => navigation.navigate('LocationForm', { location })}
          >
            <Ionicons name="create-outline" size={16} color={Colors.primary} />
            <Text style={styles.editText}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Details */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Details</Text>

        {location.address && (
          <View style={styles.detailRow}>
            <Ionicons name="location-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.detailText}>{location.address}</Text>
          </View>
        )}

        {location.phone && (
          <View style={styles.detailRow}>
            <Ionicons name="call-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.detailText}>{location.phone}</Text>
          </View>
        )}

        {location.gst_number && (
          <View style={styles.detailRow}>
            <Ionicons name="document-text-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.detailText}>GST: {location.gst_number}</Text>
          </View>
        )}

        {(location.latitude != null && location.longitude != null) ? (
          <View style={styles.detailRow}>
            <Ionicons name="navigate-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.detailText}>
              Coordinates: {Number(location.latitude).toFixed(6)}, {Number(location.longitude).toFixed(6)}
            </Text>
          </View>
        ) : (
          <View style={styles.detailRow}>
            <Ionicons name="navigate-outline" size={18} color={Colors.warning} />
            <Text style={[styles.detailText, { color: Colors.warning }]}>Coordinates not set (geofencing inactive)</Text>
          </View>
        )}

        {location.geofence_radius && (
          <View style={styles.detailRow}>
            <Ionicons name="locate-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.detailText}>Geofence: {location.geofence_radius}m radius</Text>
          </View>
        )}
      </View>

      {/* Staff */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Staff ({location.staff?.length || 0})</Text>

        {location.staff && location.staff.length > 0 ? (
          location.staff.map((s) => (
            <View key={s.id} style={styles.staffRow}>
              <View style={styles.staffAvatar}>
                <Text style={styles.staffInitial}>{s.name?.[0]?.toUpperCase()}</Text>
              </View>
              <View style={styles.staffInfo}>
                <Text style={styles.staffName}>{s.name}</Text>
                <Text style={styles.staffPhone}>{s.phone}</Text>
              </View>
              <View style={[styles.roleBadge, { backgroundColor: (ROLE_COLORS[s.role] || Colors.textLight) + '15' }]}>
                <Text style={[styles.roleLabel, { color: ROLE_COLORS[s.role] || Colors.textLight }]}>
                  {s.role?.replace('_', ' ')}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No staff assigned</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: FontSize.md, color: Colors.textSecondary },

  headerCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: 4,
    marginBottom: Spacing.sm,
  },
  typeText: { fontSize: FontSize.xs, fontWeight: '600' },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.md,
    alignSelf: 'flex-start',
  },
  editText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.md },

  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  detailText: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },

  staffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  staffAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primaryLight + '30',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.sm,
  },
  staffInitial: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  staffInfo: { flex: 1 },
  staffName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  staffPhone: { fontSize: FontSize.xs, color: Colors.textSecondary },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.full },
  roleLabel: { fontSize: FontSize.xs, fontWeight: '600', textTransform: 'capitalize' },

  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, fontStyle: 'italic' },
});
