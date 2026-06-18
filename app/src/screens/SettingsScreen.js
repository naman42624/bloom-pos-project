import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  RefreshControl,
  Switch,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const SETTING_LABELS = {
  business_name: 'Business Name',
  currency: 'Currency',
  discount_approval_threshold: 'Discount Approval Threshold (%)',
  max_refund_without_approval: 'Max Refund Without Approval (₹)',
  geofence_default_radius: 'Default Geofence Radius (m)',
  attendance_geofence_enabled: 'Geofence Attendance (1=on, 0=off)',
  low_stock_threshold: 'Low Stock Alert Threshold',
  order_prefix: 'Order Number Prefix',
  invoice_prefix: 'Invoice Number Prefix',
  receipt_footer: 'Receipt Footer Text',
  delivery_challan_copies: 'Delivery Challan Copies',
  enable_customer_credit: 'Customer Credit (1=on, 0=off)',
  default_tax_rate_id: 'Default Tax Rate ID',
  bundle_size_small: 'Small Bundle Size',
  bundle_size_medium: 'Medium Bundle Size',
  bundle_size_large: 'Large Bundle Size',
  bundle_size_bulk: 'Bulk Bundle Size',
  supplier_manager_fields: 'Supplier Fields Visible to Managers',
};

const SUPPLIER_FIELD_OPTIONS = [
  { key: 'phone', label: 'Phone Number' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
  { key: 'gst_number', label: 'GST Number' },
  { key: 'notes', label: 'Notes' },
  { key: 'materials', label: 'Linked Materials' },
  { key: 'pricing', label: 'Pricing & Orders' },
];

// Owner-only boolean preference toggles
const PREFERENCE_SETTINGS = [
  {
    key: 'pref_walkin_auto_complete',
    label: 'Auto-Complete Walk-in Orders',
    description: 'Automatically mark a walk-in order as completed when all its production tasks are finished.',
    icon: 'checkmark-circle-outline',
    iconColor: '#10B981',
  },
  {
    key: 'pref_new_v2_ui',
    label: 'New V2 Dashboard UI ✦',
    description: 'Enable the redesigned dashboard with a unified order+delivery panel, inline task management, and a refreshed visual experience.',
    icon: 'sparkles-outline',
    iconColor: '#7C3AED',
  },
  {
    key: 'pref_manager_override',
    label: 'Manager Override',
    description: 'Assume only manager and owner are operating the system. Automatically manage pickup order tasks and staff attendance.',
    icon: 'shield-checkmark-outline',
    iconColor: '#F59E0B',
  },
];


export default function SettingsScreen() {
  const { user, refreshSettings } = useAuth();
  const [settings, setSettings] = useState({});
  const [editedValues, setEditedValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isOwner = user?.role === 'owner';

  const fetchSettings = useCallback(async () => {
    try {
      const response = await api.getSettings();
      setSettings(response.data?.settings || {});
      setEditedValues({});
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchSettings();
    }, [fetchSettings])
  );

  const handleChange = (key, value) => {
    setEditedValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (Object.keys(editedValues).length === 0) return;
    setSaving(true);
    try {
      await api.updateSettings(editedValues);
      await fetchSettings();
      if (refreshSettings) await refreshSettings();
      Alert.alert('Success', 'Settings updated');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = Object.keys(editedValues).length > 0;
  const sortedKeys = Object.keys(settings)
    .filter((k) => !PREFERENCE_SETTINGS.some((p) => p.key === k))
    .sort();

  const handlePrefToggle = async (key, currentValue) => {
    if (!isOwner) return;
    const newValue = currentValue === '1' ? '0' : '1';
    try {
      await api.updateSettings({ [key]: newValue });
      setSettings((prev) => ({
        ...prev,
        [key]: { ...prev[key], value: newValue },
      }));
      if (refreshSettings) await refreshSettings();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to update preference');
    }
  };

  return (
    <DismissKeyboard>
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={false} onRefresh={fetchSettings} colors={[Colors.primary]} />}
    >
      {loading ? (
        <Text style={styles.loadingText}>Loading settings...</Text>
      ) : (
        <>
          {/* ─── Preferences Section (Owner only) ─── */}
          {isOwner && PREFERENCE_SETTINGS.some((p) => settings[p.key] !== undefined) && (
            <View style={styles.prefSection}>
              <View style={styles.prefSectionHeader}>
                <Ionicons name="options-outline" size={16} color="#7C3AED" />
                <Text style={styles.prefSectionTitle}>Preferences</Text>
              </View>
              {PREFERENCE_SETTINGS.map((pref) => {
                const val = settings[pref.key]?.value;
                if (val === undefined) return null;
                const isOn = val === '1';
                return (
                  <View key={pref.key} style={styles.prefCard}>
                    <View style={[styles.prefIconWrap, { backgroundColor: pref.iconColor + '18' }]}>
                      <Ionicons name={pref.icon} size={20} color={pref.iconColor} />
                    </View>
                    <View style={styles.prefInfo}>
                      <Text style={styles.prefLabel}>{pref.label}</Text>
                      <Text style={styles.prefDesc}>{pref.description}</Text>
                    </View>
                    <Switch
                      value={isOn}
                      onValueChange={() => handlePrefToggle(pref.key, val)}
                      trackColor={{ false: Colors.border, true: pref.iconColor + '80' }}
                      thumbColor={isOn ? pref.iconColor : Colors.textLight}
                    />
                  </View>
                );
              })}
            </View>
          )}

          {/* ─── General Settings ─── */}
          {sortedKeys.map((key) => {
            const setting = settings[key];
            const currentValue = editedValues[key] !== undefined ? editedValues[key] : setting.value;

            // Special rendering for supplier_manager_fields
            if (key === 'supplier_manager_fields') {
              const activeFields = currentValue.split(',').map((f) => f.trim()).filter(Boolean);
              const toggleField = (fieldKey) => {
                if (!isOwner) return;
                let next;
                if (activeFields.includes(fieldKey)) {
                  next = activeFields.filter((f) => f !== fieldKey);
                } else {
                  next = [...activeFields, fieldKey];
                }
                handleChange(key, next.join(','));
              };
              return (
                <View key={key} style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{SETTING_LABELS[key]}</Text>
                  <Text style={styles.settingDesc}>Choose which supplier details managers can see</Text>
                  {SUPPLIER_FIELD_OPTIONS.map((opt) => (
                    <View key={opt.key} style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>{opt.label}</Text>
                      <Switch
                        value={activeFields.includes(opt.key)}
                        onValueChange={() => toggleField(opt.key)}
                        disabled={!isOwner}
                        trackColor={{ false: Colors.border, true: Colors.primary + '80' }}
                        thumbColor={activeFields.includes(opt.key) ? Colors.primary : Colors.textLight}
                      />
                    </View>
                  ))}
                </View>
              );
            }

            return (
              <View key={key} style={styles.settingRow}>
                <Text style={styles.settingLabel}>{SETTING_LABELS[key] || key}</Text>
                {setting.description && (
                  <Text style={styles.settingDesc}>{setting.description}</Text>
                )}
                <TextInput
                  style={[styles.settingInput, !isOwner && styles.inputDisabled]}
                  value={String(currentValue)}
                  onChangeText={(text) => handleChange(key, text)}
                  editable={isOwner}
                  placeholderTextColor={Colors.textLight}
                />
              </View>
            );
          })}

          {isOwner && hasChanges && (
            <Button
              title="Save Changes"
              onPress={handleSave}
              loading={saving}
              style={styles.saveButton}
            />
          )}

          {!isOwner && (
            <View style={styles.notice}>
              <Ionicons name="information-circle-outline" size={18} color={Colors.info} />
              <Text style={styles.noticeText}>Only the owner can modify settings</Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },
  loadingText: { textAlign: 'center', color: Colors.textSecondary, marginTop: Spacing.xl },

  // Preference toggles
  prefSection: {
    marginBottom: Spacing.lg,
    backgroundColor: '#F5F3FF',
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: '#DDD6FE',
    overflow: 'hidden',
  },
  prefSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  prefSectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: '#7C3AED' },
  prefCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DDD6FE',
    backgroundColor: '#FAFAFF',
  },
  prefIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  prefInfo: { flex: 1 },
  prefLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  prefDesc: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, lineHeight: 16 },

  settingRow: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  settingLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  settingDesc: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  settingInput: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  inputDisabled: { backgroundColor: Colors.surfaceAlt, color: Colors.textSecondary },

  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  toggleLabel: { fontSize: FontSize.sm, color: Colors.text },

  saveButton: { marginTop: Spacing.lg },

  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: Colors.infoLight,
    borderRadius: BorderRadius.md,
    marginTop: Spacing.lg,
  },
  noticeText: { fontSize: FontSize.sm, color: Colors.info },
});
