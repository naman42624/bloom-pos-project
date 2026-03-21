import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const MENU_ITEMS = [
  { key: 'Attendance', icon: 'time', label: 'Attendance', roles: ['owner', 'manager'] },
  { key: 'Reports', icon: 'bar-chart', label: 'Reports', roles: ['owner', 'manager'] },
  { key: 'Customers', icon: 'people', label: 'Customers', roles: ['owner', 'manager'] },
  { key: 'RecurringOrders', icon: 'repeat', label: 'Recurring Orders', roles: ['owner', 'manager'] },
  { key: 'Staff', icon: 'person-add', label: 'Staff', roles: ['owner', 'manager'] },
  { key: 'Locations', icon: 'location', label: 'Locations', roles: ['owner', 'manager'] },
  { key: 'Settlements', icon: 'wallet', label: 'Settlements', roles: ['owner', 'manager'] },
  { key: 'CashRegister', icon: 'calculator', label: 'Cash Register', roles: ['owner', 'manager', 'employee'] },
  { key: 'Expenses', icon: 'receipt', label: 'Expenses', roles: ['owner', 'manager'] },
  { key: 'Profile', icon: 'person-circle', label: 'Profile', roles: ['owner', 'manager'] },
  { key: 'Settings', icon: 'settings', label: 'Settings', roles: ['owner'] },
];

const ICON_COLORS = ['#E91E63', '#9C27B0', '#3F51B5', '#00BCD4', '#4CAF50', '#FF9800', '#FF5722', '#795548', '#607D8B', '#F44336', '#E91E63'];

export default function MoreScreen({ navigation }) {
  const { user } = useAuth();
  const role = user?.role;

  const visible = MENU_ITEMS.filter(m => m.roles.includes(role));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.listContainer}>
        {visible.map((item, index) => {
          const iconColor = ICON_COLORS[index % ICON_COLORS.length];
          const isLast = index === visible.length - 1;
          return (
            <TouchableOpacity
              key={item.key}
              style={[styles.tile, isLast && { borderBottomWidth: 0 }]}
              onPress={() => navigation.navigate(item.key)}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, { backgroundColor: iconColor }]}>
                <Ionicons name={item.icon} size={20} color={Colors.white} />
              </View>
              <Text style={styles.tileLabel}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 100 },
  listContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.03, shadowRadius: 6, elevation: 2,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  iconWrap: {
    width: 34, height: 34, borderRadius: 8,
    justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.md,
  },
  tileLabel: { flex: 1, fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
});
