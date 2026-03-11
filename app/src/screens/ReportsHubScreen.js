import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const REPORTS = [
  { key: 'SalesReport', icon: 'trending-up', label: 'Sales Report', desc: 'Revenue, orders & trends', color: Colors.primary },
  { key: 'InventoryReport', icon: 'leaf', label: 'Inventory Report', desc: 'Stock levels & wastage', color: '#4CAF50' },
  { key: 'CustomerInsights', icon: 'people', label: 'Customer Insights', desc: 'Top customers & segments', color: '#2196F3' },
  { key: 'EmployeePerformance', icon: 'person', label: 'Employee Performance', desc: 'Sales, attendance & tasks', color: '#FF9800' },
];

export default function ReportsHubScreen({ navigation }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Reports & Analytics</Text>
      {REPORTS.map(r => (
        <TouchableOpacity
          key={r.key}
          style={styles.card}
          onPress={() => navigation.navigate(r.key)}
          activeOpacity={0.7}
        >
          <View style={[styles.iconWrap, { backgroundColor: r.color + '15' }]}>
            <Ionicons name={r.icon} size={28} color={r.color} />
          </View>
          <View style={styles.cardText}>
            <Text style={styles.cardTitle}>{r.label}</Text>
            <Text style={styles.cardDesc}>{r.desc}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  heading: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.lg },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  iconWrap: {
    width: 52, height: 52, borderRadius: 26,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  cardText: { flex: 1 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
});
