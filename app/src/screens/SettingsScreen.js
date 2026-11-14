import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, RefreshControl, Switch, Image, Platform, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { showAlert, appAlert } from '../utils/alert';

// '' / not a number / outside 0-100 → a plain message, else null.
function helperLimitProblem(value) {
  const v = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return 'Type the helper discount limit as a number from 0 to 100, like 10.';
  const n = Number(v);
  if (n < 0 || n > 100) return 'The helper discount limit must be from 0 to 100.';
  return null;
}

const SETTING_LABELS = {
  business_name: 'Business Name',
  currency: 'Currency',
  discount_approval_threshold: 'Discount Approval Threshold (%)',
  discount_helper_threshold: 'Helper discount limit %',
  discount_manager_threshold: 'Counter staff discount limit %',
  discount_owner_threshold: 'Manager discount limit %',
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
  upi_qr_image_url: 'UPI QR Code',
};

// Where helper cash goes (spec 11.1); copy from the spec, word for word
// Edited on their own screen (BillSettingsScreen), not in this list
const BILL_KEYS = ['bill_round_off', 'bill_legal_name', 'bill_pan', 'bill_terms', 'bill_show_fields', 'receipt_footer',
  'gst_delivery_rate', 'gst_delivery_sac', 'gst_default_rate', 'gst_default_hsn', 'gst_number',
  'invoice_series_mode', 'invoice_prefix', 'credit_note_prefix',
  // Edited with the Quick sale buttons
  'quick_sale_label', 'quick_sale_hsn'];

const CASH_MODE_OPTIONS = [
  {
    value: 'register',
    label: 'Straight to the register',
    description: "helpers' cash counts as drawer cash right away. Use when helpers hand you every payment.",
    icon: 'cash-outline',
  },
  {
    value: 'bag',
    label: 'Separate bag per helper',
    description: 'each helper keeps their cash and hands it over later. You always see who holds how much.',
    icon: 'wallet-outline',
  },
];

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
  {
    key: 'pref_flexible_task_assignment',
    label: 'Flexible Task Assignment',
    description: 'Let any staff member start or complete a production task, even one assigned to someone else. Turn off to require each task be done only by the person it\'s assigned to.',
    icon: 'people-outline',
    iconColor: '#3B82F6',
  },
  {
    key: 'pref_counter_marks_pickup',
    label: 'Counter Can Mark Picked Up',
    description: 'Let counter staff mark a delivery order as picked up from the shop, on behalf of the delivery partner.',
    icon: 'cube-outline',
    iconColor: '#0EA5E9',
  },
  {
    key: 'pref_counter_marks_delivered',
    label: 'Counter Can Mark Delivered',
    description: 'Let counter staff mark a delivery order as delivered, and record the COD amount collected, on behalf of the delivery partner.',
    icon: 'checkmark-done-outline',
    iconColor: '#0EA5E9',
  },
];


export default function SettingsScreen() {
  const { user, refreshSettings } = useAuth();
  const navigation = useNavigation();
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
      appAlert('Error', err.message || 'Failed to load settings');
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
    if (editedValues.discount_helper_threshold !== undefined) {
      const problem = helperLimitProblem(editedValues.discount_helper_threshold);
      if (problem) {
        showAlert('Helper discount limit', problem);
        return;
      }
    }
    setSaving(true);
    try {
      await api.updateSettings(editedValues);
      await fetchSettings();
      if (refreshSettings) await refreshSettings();
      appAlert('Success', 'Settings updated');
    } catch (err) {
      appAlert('Error', err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = Object.keys(editedValues).length > 0;
  const sortedKeys = Object.keys(settings)
    .filter((k) => !PREFERENCE_SETTINGS.some((p) => p.key === k) && k !== 'helper_cash_mode' && k !== 'discount_limits_v2' && !BILL_KEYS.includes(k))
    // One "Bill and GST" row stands for every bill setting
    .concat(settings.bill_round_off ? ['bill_round_off'] : [])
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
      appAlert('Error', err.message || 'Failed to update preference');
    }
  };

  const [cashModeSaving, setCashModeSaving] = useState(null); // value being saved
  const [cashModeError, setCashModeError] = useState('');
  const cashModeBusy = useRef(false);

  // Saves at once (no Save button); the server refuses a switch while a
  // helper still holds cash, and that message is shown right under the choices.
  const handleCashMode = async (value) => {
    if (!isOwner || cashModeBusy.current) return;
    const current = settings.helper_cash_mode?.value === 'bag' ? 'bag' : 'register';
    if (value === current) { setCashModeError(''); return; }
    cashModeBusy.current = true;
    setCashModeSaving(value);
    setCashModeError('');
    try {
      await api.updateSettings({ helper_cash_mode: value });
      setSettings((prev) => ({
        ...prev,
        helper_cash_mode: { ...prev.helper_cash_mode, value },
      }));
      if (refreshSettings) await refreshSettings();
    } catch (err) {
      setCashModeError(err.message || "Couldn't change where helper cash goes. Check the connection and tap again.");
    } finally {
      cashModeBusy.current = false;
      setCashModeSaving(null);
    }
  };

  const [uploadingQr, setUploadingQr] = useState(false);

  const handlePickQrImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      appAlert('Permission Required', 'Please allow photo library access to upload the QR code.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets?.[0]?.uri) return;

    setUploadingQr(true);
    try {
      const uri = result.assets[0].uri;
      const formData = new FormData();
      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        const blob = await response.blob();
        formData.append('image', blob, 'qr-code.jpg');
      } else {
        const filename = uri.split('/').pop();
        const ext = /\.(\w+)$/.exec(filename)?.[1] || 'jpg';
        formData.append('image', { uri, name: filename, type: `image/${ext}` });
      }
      const uploadRes = await api.uploadGenericImage(formData);
      handleChange('upi_qr_image_url', uploadRes.url);
    } catch (err) {
      appAlert('Error', err.message || 'Could not upload the image');
    } finally {
      setUploadingQr(false);
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
          {/* ─── Expense items (Owner only): pins, rename, merge, sort old entries ─── */}
          {isOwner && (
            <TouchableOpacity
              style={[styles.settingRow, { flexDirection: 'row', alignItems: 'center', minHeight: 56 }]}
              onPress={() => navigation.navigate('ExpenseItems')}
              accessibilityRole="button"
              accessibilityLabel="Expense items"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Expense items</Text>
                <Text style={styles.settingDesc}>Pin the items staff pick most, fix names, merge spellings and sort older entries</Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          )}

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

          {/* ─── Helpers: where their cash goes (owner only) ─── */}
          {isOwner && settings.helper_cash_mode !== undefined && (() => {
            const mode = settings.helper_cash_mode?.value === 'bag' ? 'bag' : 'register';
            return (
              <View style={styles.settingRow}>
                <Text style={styles.sectionTitle}>Helpers</Text>
                <Text style={styles.settingLabel}>Where helpers' cash goes</Text>
                {CASH_MODE_OPTIONS.map((opt) => {
                  const selected = mode === opt.value;
                  const saving = cashModeSaving === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.modeOption, selected && styles.modeOptionSelected]}
                      onPress={() => handleCashMode(opt.value)}
                      disabled={!!cashModeSaving}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: !!cashModeSaving }}
                      accessibilityLabel={`${opt.label}. ${opt.description}`}
                    >
                      <Ionicons
                        name={selected ? 'radio-button-on' : 'radio-button-off'}
                        size={24}
                        color={selected ? Colors.primary : Colors.textSecondary}
                      />
                      <View style={styles.modeText}>
                        <Text style={styles.modeDesc}>
                          <Text style={styles.modeLabel}>{opt.label}</Text>
                          {` — ${opt.description}`}
                        </Text>
                        {saving ? <Text style={styles.modeSaving}>Saving…</Text> : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
                {cashModeError ? (
                  <View style={styles.modeError} accessibilityLiveRegion="polite">
                    <Ionicons name="alert-circle-outline" size={18} color={Colors.error} />
                    <Text style={styles.modeErrorText}>{cashModeError}</Text>
                  </View>
                ) : null}
              </View>
            );
          })()}

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

            if (key === 'bill_round_off') {
              if (!isOwner) return null;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.settingRow, { flexDirection: 'row', alignItems: 'center', minHeight: 56 }]}
                  onPress={() => navigation.navigate('BillSettings')}
                  accessibilityRole="button"
                  accessibilityLabel="Bill and GST"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingLabel}>Bill and GST</Text>
                    <Text style={styles.settingDesc}>What the printed bill shows, GST rates, HSN codes and bill numbers</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
                </TouchableOpacity>
              );
            }

            if (key === 'quick_sale_tiles') {
              if (!isOwner) return null;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.settingRow, { flexDirection: 'row', alignItems: 'center', minHeight: 56 }]}
                  onPress={() => navigation.navigate('QuickSaleTiles')}
                  accessibilityRole="button"
                  accessibilityLabel="Quick sale buttons"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingLabel}>Quick sale buttons</Text>
                    <Text style={styles.settingDesc}>Choose the one-tap buttons counter staff see on Quick sale</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
                </TouchableOpacity>
              );
            }

            if (key === 'discount_helper_threshold') {
              if (!isOwner) return null;
              const counterLimit = (editedValues.discount_manager_threshold !== undefined
                ? editedValues.discount_manager_threshold
                : settings.discount_manager_threshold?.value) || '25';
              return (
                <View key={key} style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{SETTING_LABELS[key]}</Text>
                  <Text style={styles.settingDesc}>The biggest discount a helper can give without a PIN from the counter.</Text>
                  <TextInput
                    style={styles.settingInput}
                    value={String(currentValue)}
                    onChangeText={(text) => handleChange(key, text.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Helper discount limit percent"
                    placeholderTextColor={Colors.textLight}
                  />
                  <Text style={styles.helperLine}>Helpers can never give more than counter staff ({counterLimit}%).</Text>
                  {!helperLimitProblem(currentValue) && Number(currentValue) > Number(counterLimit) ? (
                    <Text style={styles.helperWarn}>Helpers will get {counterLimit}% (the counter limit).</Text>
                  ) : null}
                </View>
              );
            }

            if (key === 'upi_qr_image_url') {
              return (
                <View key={key} style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{SETTING_LABELS[key]}</Text>
                  <Text style={styles.settingDesc}>Shown to customers on the order-request page so they can pay by UPI.</Text>
                  {!!currentValue && (
                    <Image source={{ uri: api.getMediaUrl(currentValue) }} style={{ width: 120, height: 120, borderRadius: BorderRadius.sm, marginTop: Spacing.sm }} resizeMode="contain" />
                  )}
                  {isOwner && (
                    <Button
                      title={currentValue ? 'Replace QR Code' : 'Upload QR Code'}
                      onPress={handlePickQrImage}
                      loading={uploadingQr}
                      variant="outline"
                      size="sm"
                      style={{ marginTop: Spacing.sm, alignSelf: 'flex-start' }}
                    />
                  )}
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
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary, marginBottom: Spacing.xs },
  modeOption: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    minHeight: 56, padding: Spacing.md, marginTop: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.background,
  },
  modeOptionSelected: { borderColor: Colors.primary, backgroundColor: Colors.primary + '10' },
  modeText: { flex: 1 },
  modeLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  modeDesc: { fontSize: FontSize.md, color: Colors.textSecondary, lineHeight: 22 },
  modeSaving: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs },
  modeError: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    marginTop: Spacing.sm, padding: Spacing.sm, borderRadius: BorderRadius.sm, backgroundColor: Colors.errorLight,
  },
  modeErrorText: { flex: 1, fontSize: FontSize.md, color: Colors.error, fontWeight: '600' },
  helperLine: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs },
  helperWarn: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', marginTop: Spacing.xs },
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
