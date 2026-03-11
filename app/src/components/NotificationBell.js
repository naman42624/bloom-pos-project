import React, { useState, useCallback } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize } from '../constants/theme';

export default function NotificationBell({ navigation }) {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useFocusEffect(useCallback(() => {
    if (!user) return;
    const fetchCount = async () => {
      try {
        const res = await api.getUnreadCount();
        setCount(res.data?.count || 0);
      } catch {}
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, [user?.id]));

  return (
    <TouchableOpacity
      style={styles.bell}
      onPress={() => navigation.navigate('Notifications')}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Ionicons name={count > 0 ? 'notifications' : 'notifications-outline'} size={22} color={Colors.text} />
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bell: { marginRight: 8, padding: 4 },
  badge: {
    position: 'absolute', top: 0, right: 0,
    backgroundColor: Colors.error || '#F44336',
    borderRadius: 8, minWidth: 16, height: 16,
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 9, fontWeight: '800', color: '#fff' },
});
