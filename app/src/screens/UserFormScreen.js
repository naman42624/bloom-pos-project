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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ROLES = [
  { key: 'manager', label: 'Manager', icon: 'shield', color: Colors.roleManager },
  { key: 'employee', label: 'Employee', icon: 'person', color: Colors.roleEmployee },
  { key: 'delivery_partner', label: 'Delivery Partner', icon: 'bicycle', color: Colors.roleDelivery },
  { key: 'customer', label: 'Customer', icon: 'cart', color: Colors.roleCustomer },
];

export default function UserFormScreen({ route, navigation }) {
  const existingUser = route.params?.user;
  const isEditing = !!existingUser;
  const { user: currentUser } = useAuth();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('employee');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [locations, setLocations] = useState([]);
  const [selectedLocationIds, setSelectedLocationIds] = useState([]);

  // Manager can only create employee/delivery_partner/customer
  const availableRoles = currentUser?.role === 'owner'
    ? ROLES
    : ROLES.filter((r) => ['employee', 'delivery_partner', 'customer'].includes(r.key));

  useEffect(() => {
    if (existingUser) {
      setName(existingUser.name || '');
      setPhone(existingUser.phone || '');
      setRole(existingUser.role || 'employee');
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
    if (!isEditing && !password) newErrors.password = 'Password is required';
    else if (!isEditing && password.length < 6) newErrors.password = 'Min 6 characters';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = {
        name: name.trim(),
        phone: phone.trim(),
        role,
      };

      if (isEditing) {
        await api.updateUser(existingUser.id, { ...data, location_ids: selectedLocationIds });
      } else {
        data.password = password;
        data.location_ids = selectedLocationIds;
        await api.createUser(data);
      }

      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save user');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
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
        {/* Role selector (not for editing) */}
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

        <Input
          label={isEditing ? 'New Password (leave blank to keep current)' : 'Password'}
          value={password}
          onChangeText={(t) => { setPassword(t); clearError('password'); }}
          placeholder={isEditing ? 'Enter new password' : 'At least 6 characters'}
          secureTextEntry
          error={errors.password}
          leftIcon={<Ionicons name="lock-closed-outline" size={20} color={Colors.textSecondary} />}
        />

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

        <Button
          title={isEditing ? 'Update Staff' : 'Add Staff'}
          onPress={handleSubmit}
          loading={loading}
          style={styles.submitButton}
        />
        {isEditing && currentUser?.role === 'owner' && (
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

  submitButton: { marginTop: Spacing.xl },
  deactivateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, marginTop: Spacing.md, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.error,
    backgroundColor: Colors.error + '08',
  },
  reactivateBtn: { borderColor: Colors.success, backgroundColor: Colors.success + '08' },
  deactivateBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.error },
});
