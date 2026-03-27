import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, TextInput, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const DATA_SECTIONS = [
  { key: 'staff', label: 'Staff / Users', icon: 'people', endpoint: 'users', roleFilter: true },
  { key: 'locations', label: 'Locations', icon: 'location', endpoint: 'locations' },
  { key: 'materials', label: 'Materials', icon: 'leaf', endpoint: 'materials' },
  { key: 'products', label: 'Products', icon: 'flower', endpoint: 'products' },
  { key: 'sales', label: 'Sales / Orders', icon: 'receipt', endpoint: 'sales' },
];

export default function DataManagementScreen({ navigation }) {
  const { user } = useAuth();
  const [expandedSection, setExpandedSection] = useState(null);
  const [sectionData, setSectionData] = useState({});
  const [loading, setLoading] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [resetText, setResetText] = useState('');
  const [resetting, setResetting] = useState(false);

  // Only owners can access
  if (user?.role !== 'owner') {
    return (
      <View style={styles.container}>
        <View style={styles.empty}>
          <Ionicons name="lock-closed" size={48} color={Colors.textLight} />
          <Text style={styles.emptyText}>Owner access only</Text>
        </View>
      </View>
    );
  }

  const fetchSection = async (section) => {
    setLoading(prev => ({ ...prev, [section.key]: true }));
    try {
      let res;
      switch (section.endpoint) {
        case 'users':
          res = await api.getUsers();
          break;
        case 'locations':
          res = await api.getLocations();
          break;
        case 'materials':
          res = await api.getMaterials();
          break;
        case 'products':
          res = await api.getProducts();
          break;
        case 'sales':
          res = await api.getSales({ limit: 50 });
          break;
        default:
          res = { data: [] };
      }
      const data = res.data?.items || res.data?.locations || res.data?.users || res.data || [];
      setSectionData(prev => ({ ...prev, [section.key]: Array.isArray(data) ? data : [] }));
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to load data');
    } finally {
      setLoading(prev => ({ ...prev, [section.key]: false }));
    }
  };

  const toggleSection = (section) => {
    if (expandedSection === section.key) {
      setExpandedSection(null);
    } else {
      setExpandedSection(section.key);
      if (!sectionData[section.key]) {
        fetchSection(section);
      }
    }
  };

  const handleDelete = (section, item) => {
    const itemName = item.name || item.sale_number || `#${item.id}`;
    Alert.alert(
      'Delete Confirmation',
      `Are you sure you want to delete "${itemName}"?\n\nThis action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            setDeleting(item.id);
            try {
              await api.request(`/${section.endpoint}/${item.id}`, { method: 'DELETE' });
              setSectionData(prev => ({
                ...prev,
                [section.key]: (prev[section.key] || []).filter(i => i.id !== item.id),
              }));
              Alert.alert('Deleted', `${itemName} has been deleted.`);
            } catch (e) {
              Alert.alert('Error', e.message || 'Failed to delete');
            } finally {
              setDeleting(null);
            }
          },
        },
      ]
    );
  };

  const handleReset = () => {
    if (resetText !== 'RESET') {
      Alert.alert('Confirmation Required', 'Type "RESET" in the text field to confirm data reset.');
      return;
    }

    Alert.alert(
      '⚠️ DANGER: Reset All Data',
      'This will permanently delete ALL sales, orders, deliveries, production tasks, payments, attendance records, and settlements.\n\nProducts, materials, locations, and staff will be kept.\n\nThis CANNOT be undone!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything', style: 'destructive',
          onPress: async () => {
            setResetting(true);
            try {
              await api.request('/admin/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
              setResetText('');
              setSectionData({});
              Alert.alert('Reset Complete', 'All transactional data has been deleted.');
            } catch (e) {
              Alert.alert('Error', e.message || 'Failed to reset');
            } finally {
              setResetting(false);
            }
          },
        },
      ]
    );
  };

  const renderItem = (section, item) => {
    const isDeleting = deleting === item.id;
    let title = '';
    let subtitle = '';

    switch (section.key) {
      case 'staff':
        title = item.name || 'Unknown';
        subtitle = `${item.role} • ${item.phone || item.email || ''}`;
        if (item.id === user.id) subtitle += ' (You)';
        break;
      case 'locations':
        title = item.name;
        subtitle = item.type || 'shop';
        break;
      case 'materials':
        title = item.name;
        subtitle = `${item.category_name || ''} • Stock: ${item.stock_quantity || 0}`;
        break;
      case 'products':
        title = item.name;
        subtitle = `₹${item.base_price || 0}`;
        break;
      case 'sales':
        title = item.sale_number || `Sale #${item.id}`;
        subtitle = `${item.order_type || 'walk_in'} • ₹${item.grand_total || 0} • ${item.status || ''}`;
        break;
    }

    const canDelete = section.key !== 'staff' || item.id !== user.id; // Can't delete yourself

    return (
      <View key={item.id} style={styles.itemRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.itemTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.itemSub} numberOfLines={1}>{subtitle}</Text>
        </View>
        {canDelete && (
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => handleDelete(section, item)}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <ActivityIndicator size="small" color={Colors.danger} />
            ) : (
              <Ionicons name="trash-outline" size={18} color={Colors.danger} />
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Ionicons name="construct" size={24} color={Colors.danger} />
        <Text style={styles.headerTitle}>Data Management</Text>
      </View>
      <Text style={styles.headerDesc}>
        Manage and delete data from the application. Use with caution — deletions are permanent.
      </Text>

      {/* Data Sections */}
      {DATA_SECTIONS.map(section => (
        <View key={section.key} style={styles.section}>
          <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleSection(section)}>
            <View style={styles.sectionLeft}>
              <Ionicons name={section.icon} size={20} color={Colors.primary} />
              <Text style={styles.sectionTitle}>{section.label}</Text>
              {sectionData[section.key] && (
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>{sectionData[section.key].length}</Text>
                </View>
              )}
            </View>
            <Ionicons
              name={expandedSection === section.key ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={Colors.textSecondary}
            />
          </TouchableOpacity>

          {expandedSection === section.key && (
            <View style={styles.sectionBody}>
              {loading[section.key] ? (
                <ActivityIndicator size="small" color={Colors.primary} style={{ padding: Spacing.md }} />
              ) : (sectionData[section.key] || []).length === 0 ? (
                <Text style={styles.emptySection}>No items found</Text>
              ) : (
                (sectionData[section.key] || []).map(item => renderItem(section, item))
              )}
            </View>
          )}
        </View>
      ))}

      {/* Reset Section */}
      <View style={[styles.section, styles.dangerSection]}>
        <View style={styles.sectionHeader}>
          <View style={styles.sectionLeft}>
            <Ionicons name="nuclear" size={20} color={Colors.danger} />
            <Text style={[styles.sectionTitle, { color: Colors.danger }]}>Reset All Data</Text>
          </View>
        </View>
        <View style={styles.sectionBody}>
          <Text style={styles.resetWarning}>
            This will delete ALL sales, orders, deliveries, production tasks, payments, attendance records, 
            and settlements. Products, materials, locations, and staff will be kept.
          </Text>
          <View style={styles.resetRow}>
            <TextInput
              style={styles.resetInput}
              placeholder='Type "RESET" to confirm'
              placeholderTextColor={Colors.textLight}
              value={resetText}
              onChangeText={setResetText}
              autoCapitalize="characters"
            />
            <TouchableOpacity
              style={[styles.resetBtn, resetText !== 'RESET' && styles.resetBtnDisabled]}
              onPress={handleReset}
              disabled={resetText !== 'RESET' || resetting}
            >
              {resetting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.resetBtnText}>Reset</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },

  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.xs },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  headerDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm, overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: Spacing.md,
  },
  sectionLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  countBadge: {
    backgroundColor: Colors.primary + '20', borderRadius: BorderRadius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  countText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },

  sectionBody: { borderTopWidth: 1, borderTopColor: Colors.border },

  itemRow: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.sm,
    paddingHorizontal: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  itemTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  itemSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  deleteBtn: { padding: Spacing.xs },

  emptySection: { padding: Spacing.md, fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center' },

  dangerSection: { borderColor: Colors.danger + '40', marginTop: Spacing.md },
  resetWarning: { fontSize: FontSize.sm, color: Colors.danger, padding: Spacing.md, paddingBottom: Spacing.xs },
  resetRow: { flexDirection: 'row', padding: Spacing.md, paddingTop: Spacing.xs, gap: Spacing.sm },
  resetInput: {
    flex: 1, borderWidth: 1, borderColor: Colors.danger + '40', borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.sm, color: Colors.text,
  },
  resetBtn: {
    backgroundColor: Colors.danger, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.lg, justifyContent: 'center',
  },
  resetBtnDisabled: { opacity: 0.4 },
  resetBtnText: { color: '#fff', fontWeight: '700', fontSize: FontSize.sm },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: Spacing.sm },
});
