import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function contextLabel(context) {
  if (context === 'quick_checkout') return 'Quick Checkout';
  return 'Checkout';
}

export default function SaleDraftsScreen({ navigation, route }) {
  const locationId = route?.params?.locationId || null;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState([]);

  const loadDrafts = useCallback(async () => {
    try {
      const params = {};
      if (locationId) params.location_id = locationId;
      const res = await api.getSaleDrafts(params);
      setDrafts(res?.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load drafts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [locationId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadDrafts();
    }, [loadDrafts])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDrafts();
  }, [loadDrafts]);

  const handleResume = useCallback((draft) => {
    const target = draft.context === 'quick_checkout' ? 'QuickCheckout' : 'Checkout';
    navigation.navigate(target, { draftId: draft.id });
  }, [navigation]);

  const handleDelete = useCallback((draftId) => {
    const performDelete = async () => {
      try {
        await api.deleteSaleDraft(draftId);
        setDrafts((prev) => prev.filter((d) => d.id !== draftId));
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to delete draft');
      }
    };

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm('This draft will be permanently removed.')) {
        performDelete();
      }
      return;
    }

    Alert.alert('Delete Draft', 'This draft will be permanently removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: performDelete,
      },
    ]);
  }, []);

  const headerText = useMemo(() => {
    if (locationId) return 'Showing drafts for selected location';
    return 'Showing drafts from all locations';
  }, [locationId]);

  return (
    <View style={styles.container}>
      <Text style={styles.subHeader}>{headerText}</Text>

      {loading ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={drafts}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
          contentContainerStyle={drafts.length === 0 ? styles.emptyList : { paddingBottom: Spacing.lg }}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.customer_name || 'Unnamed draft'}</Text>
                <Text style={styles.meta}>
                  {contextLabel(item.context)} • {(item.order_type || 'walk_in').replace('_', ' ')}
                </Text>
                <Text style={styles.meta}>
                  {item.item_count || 0} items • Rs {Number(item.grand_total || 0).toFixed(2)}
                </Text>
              </View>

              <TouchableOpacity style={styles.resumeBtn} onPress={() => handleResume(item)}>
                <Ionicons name="play" size={14} color={Colors.white} />
                <Text style={styles.resumeText}>Resume</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item.id)}>
                <Ionicons name="trash-outline" size={16} color={Colors.error} />
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="document-text-outline" size={40} color={Colors.textLight} />
              <Text style={styles.emptyText}>No saved drafts yet</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    padding: Spacing.md,
  },
  subHeader: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  title: {
    fontSize: FontSize.md,
    color: Colors.text,
    fontWeight: '700',
  },
  meta: {
    marginTop: 2,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  resumeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
  },
  resumeText: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  deleteBtn: {
    borderWidth: 1,
    borderColor: Colors.error + '55',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textLight,
  },
});
