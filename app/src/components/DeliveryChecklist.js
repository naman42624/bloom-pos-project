import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatTime } from '../utils/datetime';

// Generic load checklist: one row per sale item on a delivery, with a
// checkbox anyone allowed to touch this delivery can tap, and a
// "who/when" attribution once checked. Deliberately has no role-specific
// text or behavior baked in — used as-is for the counter-staff "prep the
// rider's load" entry point (this task) and the rider's own "confirm what
// I'm carrying" entry point (a later task), reusing the exact same rows
// via GET/PUT /deliveries/:id/checklist.
export default function DeliveryChecklist({ deliveryId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState(null);
  const [error, setError] = useState('');

  const fetchChecklist = useCallback(async () => {
    try {
      setError('');
      const res = await api.getDeliveryChecklist(deliveryId);
      setItems(res.data || []);
    } catch (err) {
      setError(err.message || 'Could not load the checklist. Pull down or reopen to try again.');
    } finally {
      setLoading(false);
    }
  }, [deliveryId]);

  useEffect(() => {
    if (deliveryId) fetchChecklist();
  }, [deliveryId, fetchChecklist]);

  const toggleItem = async (item) => {
    if (togglingId) return; // avoid double-taps firing overlapping requests
    const nextChecked = !item.checked;
    setTogglingId(item.sale_item_id);
    // Optimistic flip so the tap feels instant; reconciled with the
    // server's checked_by/checked_at right after.
    setItems(prev => prev.map(it => (it.sale_item_id === item.sale_item_id ? { ...it, checked: nextChecked } : it)));
    try {
      await api.toggleDeliveryChecklistItem(deliveryId, item.sale_item_id, nextChecked);
      await fetchChecklist();
    } catch (err) {
      // Revert the optimistic flip on failure.
      setItems(prev => prev.map(it => (it.sale_item_id === item.sale_item_id ? { ...it, checked: !nextChecked } : it)));
      setError(err.message || 'Could not save that — try tapping it again.');
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle" size={16} color="#C62828" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.sale_item_id)}
        renderItem={({ item }) => {
          const isToggling = togglingId === item.sale_item_id;
          return (
            <TouchableOpacity
              style={[styles.row, item.checked && styles.rowChecked]}
              onPress={() => toggleItem(item)}
              disabled={isToggling}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, item.checked && styles.checkboxChecked]}>
                {isToggling ? (
                  <ActivityIndicator size="small" color={item.checked ? '#fff' : Colors.primary} />
                ) : item.checked ? (
                  <Ionicons name="checkmark" size={24} color="#fff" />
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.itemText, item.checked && styles.itemTextChecked]}>
                  {item.quantity}x {item.product_name}
                </Text>
                {item.checked && item.checked_by_name ? (
                  <Text style={styles.metaText}>
                    ✓ {item.checked_by_name}{item.checked_at ? `, ${formatTime(item.checked_at)}` : ''}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No items on this order.</Text>
          </View>
        }
        contentContainerStyle={items.length === 0 ? { flexGrow: 1 } : { paddingBottom: Spacing.md }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: Spacing.xl },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FFEBEE', borderRadius: BorderRadius.md,
    padding: Spacing.sm, marginBottom: Spacing.sm,
  },
  errorText: { color: '#C62828', fontSize: FontSize.sm, flex: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.sm, minHeight: 64,
  },
  rowChecked: { backgroundColor: '#E8F5E9', borderColor: Colors.success },
  checkbox: {
    width: 32, height: 32, borderRadius: 8,
    borderWidth: 2, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: Colors.background,
  },
  checkboxChecked: { backgroundColor: Colors.success, borderColor: Colors.success },
  itemText: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  itemTextChecked: { color: Colors.success },
  metaText: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight },
});
