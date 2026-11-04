import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import DateTimePickerModal from '../components/DateTimePickerModal';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert } from '../utils/alert';
import { getShopTodayStr, getShopNow } from '../utils/datetime';
import {
  addDaysStr, dateStrToDate, dateToDateStr, formatWeekdayDayMonth,
} from '../utils/helperAccess';

const ROLES = [
  { key: 'owner', label: 'Owner', icon: 'key', color: Colors.roleOwner || '#EAB308' },
  { key: 'manager', label: 'Manager', icon: 'shield', color: Colors.roleManager },
  { key: 'employee', label: 'Employee (legacy)', icon: 'person', color: Colors.roleEmployee },
  { key: 'counter_staff', label: 'Counter Staff', icon: 'storefront', color: Colors.roleCounterStaff },
  { key: 'florist_staff', label: 'Florist/Prep Staff', icon: 'flower', color: Colors.roleFloristStaff },
  { key: 'delivery_partner', label: 'Delivery Partner', icon: 'bicycle', color: Colors.roleDelivery },
  { key: 'customer', label: 'Customer', icon: 'cart', color: Colors.roleCustomer },
];

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee (legacy)',
  counter_staff: 'Counter Staff',
  florist_staff: 'Florist/Prep Staff',
  delivery_partner: 'Delivery Partner',
  customer: 'Customer',
  helper: 'Helper',
};

export default function UserFormScreen({ route, navigation }) {
  const existingUser = route.params?.user;
  const isEditing = !!existingUser;
  const { user: currentUser, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);
  const isHelper = isEditing && existingUser?.role === 'helper';

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('employee');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [locations, setLocations] = useState([]);
  const [selectedLocationIds, setSelectedLocationIds] = useState([]);

  // Role change state (edit mode, owner only)
  const [selectedNewRole, setSelectedNewRole] = useState(null);

  // PIN set/reset state (edit mode, staff accounts with an employee code)
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinSaving, setPinSaving] = useState(false);

  // Helper access (edit mode, helper accounts): extend Works until.
  const [worksUntil, setWorksUntil] = useState(existingUser?.access_until ? String(existingUser.access_until).slice(0, 10) : null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Approval PIN (owner only, for manager/owner accounts): approves a
  // helper's discount, never signs anyone in.
  const [approvalPin, setApprovalPin] = useState('');
  const [approvalPin2, setApprovalPin2] = useState('');
  const [approvalPinError, setApprovalPinError] = useState(null);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [approvalCode, setApprovalCode] = useState(existingUser?.employee_code || null);
  const guardSubmit = useSubmitGuard();

  const isOwner = currentUser?.role === 'owner';
  const showApprovalPin = isEditing && isOwner && ['manager', 'owner'].includes(existingUser?.role);
  const canChangeRole = isEditing && isOwner && existingUser?.id !== currentUser?.id;

  // Manager can only create employee/counter_staff/florist_staff/delivery_partner/customer
  const availableRoles = isOwner
    ? ROLES
    : ROLES.filter((r) => ['employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'customer'].includes(r.key));

  useEffect(() => {
    if (existingUser) {
      setName(existingUser.name || '');
      setPhone(existingUser.phone || '');
      setRole(existingUser.role || 'employee');
      setSelectedNewRole(existingUser.role || 'employee');
      fetchUserLocations(existingUser.id);
    }
    fetchLocations();
  }, [existingUser]);

  const fetchUserLocations = async (userId) => {
    try {
      const response = await api.getUser(userId);
      const userLocations = response.data?.locations || [];
      setSelectedLocationIds(userLocations.map((l) => l.id));
    } catch {
      // non-critical
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await api.getLocations();
      setLocations(response.data?.locations || []);
    } catch {
      // non-critical
    }
  };

  const toggleLocation = (locId) => {
    setSelectedLocationIds((prev) =>
      prev.includes(locId) ? prev.filter((id) => id !== locId) : [...prev, locId]
    );
  };

  const validate = () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Name is required';
    if (!phone.trim()) newErrors.phone = 'Phone number is required';
    else if (!/^[6-9]\d{9}$/.test(phone.trim())) newErrors.phone = 'Enter a valid 10-digit number';
    if (isHelper && !worksUntil) newErrors.worksUntil = 'Pick the last day this helper can work.';
    if (!isEditing && !password) newErrors.password = 'Password is required';
    else if (!isEditing && password.length < 6) newErrors.password = 'Min 6 characters';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = { name: name.trim(), phone: phone.trim(), role };
      if (isEditing) {
        const update = { ...data, location_ids: selectedLocationIds };
        if (isHelper) update.access_until = worksUntil;
        await api.updateUser(existingUser.id, update);
      } else {
        data.password = password;
        data.location_ids = selectedLocationIds;
        await api.createUser(data);
      }
      navigation.goBack();
    } catch (err) {
      const first = Array.isArray(err?.errors) && err.errors[0]?.msg;
      showAlert("Couldn't save", first || err.message || 'Check the internet and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleChangeRole = () => {
    if (!selectedNewRole || selectedNewRole === existingUser?.role) {
      Alert.alert('No Change', 'Please select a different role first.');
      return;
    }
    const newRoleLabel = ROLE_LABELS[selectedNewRole] || selectedNewRole;
    const currentRoleLabel = ROLE_LABELS[existingUser?.role] || existingUser?.role;

    const doChange = async () => {
      setLoading(true);
      try {
        await api.changeUserRole(existingUser.id, selectedNewRole);
        Alert.alert(
          'Role Updated',
          `${existingUser.name}'s role has been changed from ${currentRoleLabel} to ${newRoleLabel}.`,
          [{ text: 'OK', onPress: () => navigation.goBack() }]
        );
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to change role');
      } finally {
        setLoading(false);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Change ${existingUser?.name}'s role from ${currentRoleLabel} to ${newRoleLabel}?\n\nThis will affect their access permissions immediately.`)) {
        doChange();
      }
    } else {
      Alert.alert(
        'Change Role?',
        `Change ${existingUser?.name}'s role from ${currentRoleLabel} to ${newRoleLabel}?\n\nThis will affect their access permissions immediately.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change Role', style: 'destructive', onPress: doChange },
        ]
      );
    }
  };

  const handleSetPin = () => {
    setNewPin('');
    setPinModalVisible(true);
  };

  const submitPin = async () => {
    if (!/^\d{4}$/.test(newPin)) {
      Alert.alert('Invalid PIN', 'Enter exactly 4 digits.');
      return;
    }
    setPinSaving(true);
    try {
      await api.setUserPin(existingUser.id, newPin);
      setPinModalVisible(false);
      Alert.alert('PIN Set', `${existingUser.name}'s PIN has been updated.`);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to set PIN');
    } finally {
      setPinSaving(false);
    }
  };

  const submitApprovalPin = async () => {
    if (!/^\d{4}$/.test(approvalPin)) {
      setApprovalPinError('Type 4 digits.');
      return;
    }
    if (approvalPin !== approvalPin2) {
      setApprovalPinError("The two PINs don't match — try again");
      setApprovalPin2('');
      return;
    }
    setApprovalPinError(null);
    setApprovalSaving(true);
    try {
      const res = await api.setUserPin(existingUser.id, approvalPin);
      const code = res.data?.employee_code || approvalCode;
      setApprovalCode(code);
      setApprovalPin('');
      setApprovalPin2('');
      showAlert('Approval PIN saved', code
        ? `To approve a helper's discount, ${existingUser.name} types code ${code} and this PIN.`
        : 'Approval PIN saved.');
    } catch (err) {
      showAlert("Couldn't save the PIN", err?.message || 'Check the internet and tap Save PIN again.');
    } finally {
      setApprovalSaving(false);
    }
  };

  const handleToggleActive = async () => {
    const isActive = existingUser.is_active;
    const action = isActive ? 'Deactivate' : 'Reactivate';
    const doToggle = async () => {
      setLoading(true);
      try {
        await api.updateUser(existingUser.id, { is_active: isActive ? 0 : 1 });
        Alert.alert('Success', `Staff member ${action.toLowerCase()}d`);
        navigation.goBack();
      } catch (err) {
        Alert.alert('Error', err.message || `Failed to ${action.toLowerCase()} staff`);
      } finally {
        setLoading(false);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`${action} this staff member?`)) doToggle();
    } else {
      Alert.alert(action, `${action} ${existingUser.name}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: action, style: isActive ? 'destructive' : 'default', onPress: doToggle },
      ]);
    }
  };

  const handleResetPassword = async () => {
    if (!password || password.length < 6) {
      Alert.alert('Error', 'Enter a new password (min 6 characters)');
      return;
    }
    setLoading(true);
    try {
      await api.resetUserPassword(existingUser.id, password);
      Alert.alert('Success', 'Password has been reset');
      setPassword('');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const clearError = (field) => {
    if (errors[field]) setErrors({ ...errors, [field]: null });
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {/* Role selector (create mode only) */}
          {!isEditing && (
            <>
              <Text style={styles.label}>Role</Text>
              <View style={styles.roleGrid}>
                {availableRoles.map((r) => (
                  <TouchableOpacity
                    key={r.key}
                    style={[styles.roleOption, role === r.key && { borderColor: r.color, backgroundColor: r.color + '10' }]}
                    onPress={() => setRole(r.key)}
                  >
                    <Ionicons name={r.icon} size={20} color={role === r.key ? r.color : Colors.textLight} />
                    <Text style={[styles.roleOptionText, role === r.key && { color: r.color }]}>
                      {r.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          <Input
            label="Full Name"
            value={name}
            onChangeText={(t) => { setName(t); clearError('name'); }}
            placeholder="Staff member's name"
            autoCapitalize="words"
            error={errors.name}
            leftIcon={<Ionicons name="person-outline" size={20} color={Colors.textSecondary} />}
          />

          <Input
            label="Phone Number"
            value={phone}
            onChangeText={(t) => { setPhone(t); clearError('phone'); }}
            placeholder="10-digit mobile number"
            keyboardType="phone-pad"
            maxLength={10}
            error={errors.phone}
            editable={!isEditing}
            leftIcon={<Ionicons name="call-outline" size={20} color={Colors.textSecondary} />}
          />

          {!isHelper && (
          <Input
            label={isEditing ? 'New Password (leave blank to keep current)' : 'Password'}
            value={password}
            onChangeText={(t) => { setPassword(t); clearError('password'); }}
            placeholder={isEditing ? 'Enter new password' : 'At least 6 characters'}
            secureTextEntry
            error={errors.password}
            leftIcon={<Ionicons name="lock-closed-outline" size={20} color={Colors.textSecondary} />}
          />
          )}

          {isHelper && (
            <View style={styles.helperCard}>
              <Text style={styles.label}>Works until</Text>
              <TouchableOpacity
                style={styles.dateButton}
                onPress={() => setShowDatePicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Works until ${formatWeekdayDayMonth(worksUntil)}. Tap to change.`}
              >
                <Ionicons name="calendar-outline" size={22} color={Colors.primary} />
                <Text style={styles.dateText}>{worksUntil ? formatWeekdayDayMonth(worksUntil) : 'Pick a date'}</Text>
                <Text style={styles.dateChange}>Change</Text>
              </TouchableOpacity>
              <View style={styles.chipRow}>
                {[7, 14, 30].map((days) => {
                  const base = worksUntil && worksUntil > today ? worksUntil : today;
                  return (
                    <TouchableOpacity
                      key={days}
                      style={styles.chip}
                      onPress={() => { setWorksUntil(addDaysStr(base, days)); clearError('worksUntil'); }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.chipText}>+{days === 7 ? '1 week' : days === 14 ? '2 weeks' : '1 month'}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {worksUntil && worksUntil < today ? (
                <Text style={styles.helperHint}>Their access ended. Pick a new date and tap Update Staff to let them work again.</Text>
              ) : (
                <Text style={styles.helperHint}>They can work all of that day. Tap Update Staff to save a new date.</Text>
              )}
              {!!errors.worksUntil && <Text style={styles.fieldError}>{errors.worksUntil}</Text>}

              {existingUser?.is_active ? (
                <TouchableOpacity
                  style={styles.joinCodeBtn}
                  onPress={() => navigation.navigate('HelperJoinQR', { helper: existingUser })}
                  accessibilityRole="button"
                >
                  <Ionicons name="qr-code-outline" size={20} color={Colors.primary} />
                  <Text style={styles.joinCodeText}>Show join code</Text>
                </TouchableOpacity>
              ) : null}
              <Text style={styles.helperHint}>A new join code cancels the old one. Use it when they get a new phone or can't sign in.</Text>
            </View>
          )}

          {isEditing && password.length > 0 && (
            <Button
              title="Reset Password"
              variant="outline"
              onPress={handleResetPassword}
              loading={loading}
              style={styles.resetButton}
            />
          )}

          {/* Location assignment */}
          {locations.length > 0 && (
            <>
              <Text style={[styles.label, { marginTop: Spacing.md }]}>Assign to Locations</Text>
              {locations.map((loc) => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.locationOption, selectedLocationIds.includes(loc.id) && styles.locationSelected]}
                  onPress={() => toggleLocation(loc.id)}
                >
                  <Ionicons
                    name={selectedLocationIds.includes(loc.id) ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={selectedLocationIds.includes(loc.id) ? Colors.primary : Colors.textLight}
                  />
                  <View style={styles.locationInfo}>
                    <Text style={styles.locationName}>{loc.name}</Text>
                    <Text style={styles.locationType}>{loc.type}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </>
          )}

          {/* ─── Change Role Section (Owner editing non-owner only) ─── */}
          {canChangeRole && (
            <View style={styles.changeRoleCard}>
              <View style={styles.changeRoleHeader}>
                <Ionicons name="shield-half-outline" size={18} color="#7C3AED" />
                <Text style={styles.changeRoleTitle}>Change Role</Text>
              </View>
              <Text style={styles.changeRoleHint}>
                Current: <Text style={styles.changeRoleCurrent}>{ROLE_LABELS[existingUser?.role] || existingUser?.role}</Text>
                {'  '}·{'  '}Select a new role below to change access permissions.
              </Text>
              <View style={styles.roleGrid}>
                {ROLES.map((r) => (
                  <TouchableOpacity
                    key={r.key}
                    style={[
                      styles.roleOption,
                      selectedNewRole === r.key && { borderColor: r.color, backgroundColor: r.color + '10' },
                    ]}
                    onPress={() => setSelectedNewRole(r.key)}
                  >
                    <Ionicons name={r.icon} size={18} color={selectedNewRole === r.key ? r.color : Colors.textLight} />
                    <Text style={[styles.roleOptionText, selectedNewRole === r.key && { color: r.color }]}>
                      {r.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {selectedNewRole && selectedNewRole !== existingUser?.role && (
                <TouchableOpacity
                  style={styles.changeRoleBtn}
                  onPress={handleChangeRole}
                  disabled={loading}
                >
                  <Ionicons name="swap-horizontal" size={16} color="#fff" />
                  <Text style={styles.changeRoleBtnText}>
                    Change to {ROLE_LABELS[selectedNewRole]}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {isEditing && ['counter_staff', 'florist_staff', 'employee'].includes(existingUser?.role) && (
            <View style={styles.pinSection}>
              <Text style={styles.sectionLabel}>Shared-device login</Text>
              {existingUser?.employee_code ? (
                <>
                  <Text style={styles.employeeCodeText}>Employee code: {existingUser.employee_code}</Text>
                  <TouchableOpacity style={styles.setPinButton} onPress={handleSetPin}>
                    <Ionicons name="keypad" size={18} color={Colors.primary} />
                    <Text style={styles.setPinButtonText}>Set / Reset PIN</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <Text style={styles.noCodeText}>
                  No employee code yet — change this account's role to Counter Staff or Florist/Prep Staff above and save, or recreate it as one of those roles, to get a code.
                </Text>
              )}
            </View>
          )}

          {showApprovalPin && (
            <View style={styles.pinSection}>
              <Text style={styles.sectionLabel}>Approval PIN</Text>
              <Text style={styles.approvalHint}>Used only to approve a helper's discount. It can't open the counter app.</Text>
              {approvalCode ? (
                <Text style={styles.employeeCodeText}>Code: {approvalCode}</Text>
              ) : null}
              <Input
                label="New 4-digit PIN"
                value={approvalPin}
                onChangeText={(t) => { setApprovalPin(t.replace(/[^0-9]/g, '').slice(0, 4)); setApprovalPinError(null); }}
                keyboardType="number-pad"
                maxLength={4}
                secureTextEntry
                placeholder="4 digits"
              />
              <Input
                label="Type it again"
                value={approvalPin2}
                onChangeText={(t) => { setApprovalPin2(t.replace(/[^0-9]/g, '').slice(0, 4)); setApprovalPinError(null); }}
                keyboardType="number-pad"
                maxLength={4}
                secureTextEntry
                placeholder="4 digits"
                error={approvalPinError}
              />
              <Button
                title="Save PIN"
                variant="outline"
                onPress={guardSubmit(submitApprovalPin)}
                loading={approvalSaving}
              />
            </View>
          )}

          <Button
            title={isEditing ? 'Update Staff' : 'Add Staff'}
            onPress={handleSubmit}
            loading={loading}
            style={styles.submitButton}
          />

          {isEditing && isOwner && (
            <TouchableOpacity
              style={[styles.deactivateBtn, !existingUser.is_active && styles.reactivateBtn]}
              onPress={handleToggleActive}
              disabled={loading}
            >
              <Ionicons
                name={existingUser.is_active ? 'person-remove-outline' : 'person-add-outline'}
                size={18}
                color={existingUser.is_active ? Colors.error : Colors.success}
              />
              <Text style={[styles.deactivateBtnText, !existingUser.is_active && { color: Colors.success }]}>
                {existingUser.is_active ? 'Deactivate Staff' : 'Reactivate Staff'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {isHelper && (
        <DateTimePickerModal
          visible={showDatePicker}
          mode="date"
          value={worksUntil ? dateStrToDate(worksUntil) : getShopNow(timezone)}
          minimumDate={getShopNow(timezone)}
          title="Works until"
          onCancel={() => setShowDatePicker(false)}
          onConfirm={(d) => {
            setShowDatePicker(false);
            const picked = dateToDateStr(d);
            setWorksUntil(picked < today ? today : picked);
            clearError('worksUntil');
          }}
        />
      )}

      <Modal visible={pinModalVisible} transparent animationType="fade" onRequestClose={() => setPinModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Set PIN for {existingUser?.name}</Text>
            <Input
              value={newPin}
              onChangeText={(t) => setNewPin(t.replace(/[^0-9]/g, '').slice(0, 4))}
              keyboardType="number-pad"
              placeholder="4-digit PIN"
              maxLength={4}
              secureTextEntry
            />
            <View style={styles.modalButtons}>
              <Button title="Cancel" variant="secondary" onPress={() => setPinModalVisible(false)} />
              <Button title={pinSaving ? 'Saving…' : 'Save PIN'} onPress={submitPin} disabled={pinSaving} />
            </View>
          </View>
        </View>
      </Modal>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { padding: Spacing.lg, paddingBottom: Spacing.xxl },

  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },

  roleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.lg },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  roleOptionText: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textSecondary },

  resetButton: { marginTop: Spacing.sm },

  locationOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm + 2,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  locationSelected: { borderColor: Colors.primary, backgroundColor: Colors.primary + '08' },
  locationInfo: { flex: 1 },
  locationName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  locationType: { fontSize: FontSize.xs, color: Colors.textSecondary, textTransform: 'capitalize' },

  // Change Role
  changeRoleCard: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: '#F5F3FF',
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: '#DDD6FE',
  },
  changeRoleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: 6,
  },
  changeRoleTitle: { fontSize: FontSize.sm, fontWeight: '700', color: '#7C3AED' },
  changeRoleHint: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: Spacing.md, lineHeight: 17 },
  changeRoleCurrent: { fontWeight: '700', color: '#7C3AED' },
  changeRoleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm + 2,
    borderRadius: BorderRadius.md,
    backgroundColor: '#7C3AED',
  },
  changeRoleBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: '#fff' },

  submitButton: { marginTop: Spacing.xl },
  deactivateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, marginTop: Spacing.md, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.error,
    backgroundColor: Colors.error + '08',
  },
  reactivateBtn: { borderColor: Colors.success, backgroundColor: Colors.success + '08' },
  deactivateBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.error },

  // Shared-device login (employee code + PIN)
  pinSection: { marginTop: Spacing.lg, padding: Spacing.md, backgroundColor: Colors.background, borderRadius: BorderRadius.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginBottom: Spacing.sm },
  employeeCodeText: { fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.sm },
  setPinButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  setPinButtonText: { color: Colors.primary, fontWeight: '600' },
  noCodeText: { fontSize: FontSize.sm, color: Colors.textLight },
  approvalHint: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.sm, lineHeight: 22 },

  // Helper access
  helperCard: { marginTop: Spacing.md, padding: Spacing.md, backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border },
  dateButton: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    minHeight: 52, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  dateText: { flex: 1, fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  dateChange: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '500' },
  helperHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm },
  fieldError: { fontSize: FontSize.sm, color: Colors.error, marginTop: Spacing.xs },
  joinCodeBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48, marginTop: Spacing.md },
  joinCodeText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: Spacing.lg },
  modalCard: { backgroundColor: Colors.white, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.md },
});
