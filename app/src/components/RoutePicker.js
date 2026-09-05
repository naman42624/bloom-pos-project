/**
 * RoutePicker — chip-row picker for a delivery's route tag.
 *
 * A route here is just a manual grouping label for dispatch (e.g. "North
 * Zone", "Model Town") — NOT a turn-by-turn routing feature. Fetches the
 * active route list for the given location on mount, renders it as a
 * horizontal chip row (matching SettlementsScreen's location-chip pattern),
 * plus a trailing "+ Add route" chip that reveals a small text input for
 * creating (or finding, if the name already exists) a new one.
 *
 * Usage: <RoutePicker value={routeId} onChange={setRouteId} locationId={selectedLocation} />
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function showError(message) {
  if (Platform.OS === 'web') window.alert(message);
  else require('react-native').Alert.alert('Could not add route', message);
}

export default function RoutePicker({ value, onChange, locationId }) {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newRouteName, setNewRouteName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getDeliveryRoutes(locationId);
      setRoutes(res.data?.routes || []);
    } catch {
      // Not fetching a route list shouldn't block placing the order — staff
      // can still add a new route by name below, or just skip it.
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => {
    fetchRoutes();
  }, [fetchRoutes]);

  const confirmAdd = async () => {
    const name = newRouteName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await api.createOrFindDeliveryRoute(name, locationId);
      const newRoute = res.data;
      setAdding(false);
      setNewRouteName('');
      onChange(newRoute.id);
      fetchRoutes();
    } catch (err) {
      showError(err.message || 'Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {loading && <ActivityIndicator color={Colors.primary} style={{ marginHorizontal: Spacing.sm }} />}
        {!loading && routes.map((r) => (
          <TouchableOpacity
            key={r.id}
            style={[styles.chip, value === r.id && styles.chipActive]}
            onPress={() => onChange(r.id)}
          >
            <Text style={[styles.chipText, value === r.id && styles.chipTextActive]}>{r.name}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.chip, styles.addChip]}
          onPress={() => setAdding(true)}
        >
          <Ionicons name="add" size={16} color={Colors.primary} />
          <Text style={styles.addChipText}>Add route</Text>
        </TouchableOpacity>
      </ScrollView>

      {adding && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            placeholder="Route name (e.g. North Zone)"
            placeholderTextColor={Colors.textLight}
            value={newRouteName}
            onChangeText={setNewRouteName}
            autoFocus
          />
          <TouchableOpacity
            style={[styles.confirmBtn, (!newRouteName.trim() || creating) && styles.confirmBtnDisabled]}
            onPress={confirmAdd}
            disabled={!newRouteName.trim() || creating}
          >
            {creating
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name="checkmark" size={20} color="#fff" />
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => { setAdding(false); setNewRouteName(''); }}
          >
            <Ionicons name="close" size={20} color={Colors.textLight} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = {
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full || 999, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border, minHeight: 44,
  },
  chipActive: { backgroundColor: Colors.text, borderColor: Colors.text },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  addChip: { borderStyle: 'dashed', borderColor: Colors.primary },
  addChipText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: Spacing.sm },
  addInput: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: FontSize.md, minHeight: 44,
  },
  confirmBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  confirmBtnDisabled: { backgroundColor: Colors.border },
  cancelBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceAlt, alignItems: 'center', justifyContent: 'center',
  },
};
