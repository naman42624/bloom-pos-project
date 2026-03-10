import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const MENU_ITEMS = [
  { key: 'Customers', icon: 'people', label: 'Customers', roles: ['owner', 'manager'] },
  { key: 'RecurringOrders', icon: 'repeat', label: 'Recurring Orders', roles: ['owner', 'manager'] },
  { key: 'Locations', icon: 'location', label: 'Locations', roles: ['owner', 'manager'] },
  { key: 'Staff', icon: 'person-add', label: 'Staff', roles: ['owner', 'manager'] },
  { key: 'Settlements', icon: 'wallet', label: 'Settlements', roles: ['owner', 'manager'] },
  { key: 'CashRegister', icon: 'calculator', label: 'Cash Register', roles: ['owner', 'manager', 'employee'] },
  { key: 'Expenses', icon: 'receipt', label: 'Expenses', roles: ['owner', 'manager'] },
  { key: 'Settings', icon: 'settings', label: 'Settings', roles: ['owner'] },
];

export default function MoreScreen({ navigation }) {
  const { user } = useAuth();
  const role = user?.role;

  const visible = MENU_ITEMS.filter(m => m.roles.includes(role));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.grid}>
        {visible.map(item => (
          <TouchableOpacity
            key={item.key}
            style={styles.tile}
            onPress={() => navigation.navigate(item.key)}
            activeOpacity={0.7}
          >
            <View style={styles.iconWrap}>
              <Ionicons name={item.icon} size={28} color={Colors.primary} />
            </View>
            <Text style={styles.tileLabel}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  tile: {
    width: '47%',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  iconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary + '12',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  tileLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, textAlign: 'center' },
});
