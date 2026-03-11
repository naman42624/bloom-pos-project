import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TYPE_ICONS = {
  new_order: { name: 'cart', color: Colors.primary },
  order_status: { name: 'bag-check', color: Colors.success },
  delivery: { name: 'bicycle', color: '#2196F3' },
  production: { name: 'construct', color: '#9C27B0' },
  low_stock: { name: 'warning', color: '#FF9800' },
  attendance: { name: 'time', color: '#00BCD4' },
  general: { name: 'notifications', color: Colors.textSecondary },
};

export default function NotificationCenterScreen({ navigation }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchNotifications = async () => {
    try {
      const res = await api.getNotifications({ limit: 100 });
      setNotifications(res.data?.notifications || []);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => {
    fetchNotifications();
  }, []));

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
    } catch {}
  };

  const handlePress = async (notification) => {
    // Mark as read
    if (!notification.is_read) {
      try {
        await api.markNotificationRead(notification.id);
        setNotifications(prev =>
          prev.map(n => n.id === notification.id ? { ...n, is_read: 1 } : n)
        );
      } catch {}
    }

    // Navigate based on type/data
    try {
      const data = JSON.parse(notification.data || '{}');
      if (data.screen === 'SaleDetail' && data.saleId) {
        navigation.navigate('SaleDetail', { saleId: data.saleId });
      } else if (data.screen === 'CustomerOrderDetail' && data.saleId) {
        navigation.navigate('CustomerOrderDetail', { saleId: data.saleId });
      } else if (data.screen === 'DeliveryDetail' && data.deliveryId) {
        navigation.navigate('DeliveryDetail', { deliveryId: data.deliveryId });
      } else if (data.screen === 'ProductionQueue') {
        navigation.navigate('ProductionQueue');
      } else if (data.screen === 'MaterialDetail' && data.materialId) {
        navigation.navigate('MaterialDetail', { materialId: data.materialId });
      }
    } catch {}
  };

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  };

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const renderNotification = ({ item }) => {
    const iconInfo = TYPE_ICONS[item.type] || TYPE_ICONS.general;
    return (
      <TouchableOpacity
        style={[styles.card, !item.is_read && styles.cardUnread]}
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.iconCircle, { backgroundColor: iconInfo.color + '15' }]}>
          <Ionicons name={iconInfo.name} size={20} color={iconInfo.color} />
        </View>
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, !item.is_read && styles.titleUnread]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          </View>
          <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
        </View>
        {!item.is_read && <View style={styles.unreadDot} />}
      </TouchableOpacity>
    );
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
      {/* Header actions */}
      {unreadCount > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={handleMarkAllRead}>
          <Ionicons name="checkmark-done" size={16} color={Colors.primary} />
          <Text style={styles.markAllText}>Mark all as read ({unreadCount})</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={notifications}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderNotification}
        contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="notifications-off-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyTitle}>No notifications yet</Text>
            <Text style={styles.emptyDesc}>You'll receive updates about orders, deliveries, and more</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { paddingVertical: Spacing.xs },
  emptyContainer: { flex: 1 },
  markAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  markAllText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  cardUnread: { backgroundColor: Colors.primary + '06' },
  iconCircle: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  content: { flex: 1 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  title: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text, flex: 1 },
  titleUnread: { fontWeight: '700' },
  time: { fontSize: FontSize.xs, color: Colors.textLight, marginLeft: Spacing.sm },
  body: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: Colors.primary,
  },
  empty: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: Spacing.xl, gap: Spacing.sm,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  emptyDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
});
