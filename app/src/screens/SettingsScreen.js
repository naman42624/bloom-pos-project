import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  RefreshControl,
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
};

export default function SettingsScreen() {
  const { user } = useAuth();
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
      Alert.alert('Success', 'Settings updated');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = Object.keys(editedValues).length > 0;
  const sortedKeys = Object.keys(settings).sort();

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
          {sortedKeys.map((key) => {
            const setting = settings[key];
            const currentValue = editedValues[key] !== undefined ? editedValues[key] : setting.value;

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
