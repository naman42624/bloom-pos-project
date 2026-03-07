import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function LocationFormScreen({ route, navigation }) {
  const existingLocation = route.params?.location;
  const isEditing = !!existingLocation;

  const [name, setName] = useState('');
  const [type, setType] = useState('shop');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [geofenceRadius, setGeofenceRadius] = useState('50');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (existingLocation) {
      setName(existingLocation.name || '');
      setType(existingLocation.type || 'shop');
      setAddress(existingLocation.address || '');
      setPhone(existingLocation.phone || '');
      setGstNumber(existingLocation.gst_number || '');
      setGeofenceRadius(String(existingLocation.geofence_radius || 50));
    }
  }, [existingLocation]);

  const validate = () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Location name is required';
    if (phone && !/^[6-9]\d{9}$/.test(phone.trim())) newErrors.phone = 'Enter a valid 10-digit number';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = {
        name: name.trim(),
        type,
        address: address.trim() || undefined,
        phone: phone.trim() || undefined,
        gst_number: gstNumber.trim() || undefined,
        geofence_radius: parseInt(geofenceRadius, 10) || 50,
      };

      if (isEditing) {
        await api.updateLocation(existingLocation.id, data);
      } else {
        await api.createLocation(data);
      }

      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save location');
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
        {/* Type selector */}
        <Text style={styles.label}>Type</Text>
        <View style={styles.typeRow}>
          <TypeButton
            label="Shop"
            icon="storefront"
            active={type === 'shop'}
            onPress={() => setType('shop')}
          />
          <TypeButton
            label="Warehouse"
            icon="cube"
            active={type === 'warehouse'}
            onPress={() => setType('warehouse')}
          />
        </View>

        <Input
          label="Location Name"
          value={name}
          onChangeText={(t) => { setName(t); clearError('name'); }}
          placeholder="e.g. Main Branch, Godown #1"
          autoCapitalize="words"
          error={errors.name}
          leftIcon={<Ionicons name="business-outline" size={20} color={Colors.textSecondary} />}
        />

        <Input
          label="Address"
          value={address}
          onChangeText={setAddress}
          placeholder="Full address"
          multiline
          numberOfLines={3}
          leftIcon={<Ionicons name="location-outline" size={20} color={Colors.textSecondary} />}
        />

        <Input
          label="Phone"
          value={phone}
          onChangeText={(t) => { setPhone(t); clearError('phone'); }}
          placeholder="Location contact number"
          keyboardType="phone-pad"
          maxLength={10}
          error={errors.phone}
          leftIcon={<Ionicons name="call-outline" size={20} color={Colors.textSecondary} />}
        />

        <Input
          label="GST Number"
          value={gstNumber}
          onChangeText={setGstNumber}
          placeholder="Optional"
          autoCapitalize="characters"
          leftIcon={<Ionicons name="document-text-outline" size={20} color={Colors.textSecondary} />}
        />

        <Input
          label="Geofence Radius (meters)"
          value={geofenceRadius}
          onChangeText={setGeofenceRadius}
          placeholder="50"
          keyboardType="number-pad"
          leftIcon={<Ionicons name="locate-outline" size={20} color={Colors.textSecondary} />}
        />

        <Button
          title={isEditing ? 'Update Location' : 'Create Location'}
          onPress={handleSubmit}
          loading={loading}
          style={styles.submitButton}
        />
      </ScrollView>
    </KeyboardAvoidingView>
    </DismissKeyboard>
  );
}

function TypeButton({ label, icon, active, onPress }) {
  return (
    <Button
      title={label}
      variant={active ? 'primary' : 'outline'}
      onPress={onPress}
      icon={<Ionicons name={icon} size={18} color={active ? Colors.white : Colors.primary} />}
      style={styles.typeButton}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { padding: Spacing.lg, paddingBottom: Spacing.xxl },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs + 2 },
  typeRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.lg },
  typeButton: { flex: 1 },
  submitButton: { marginTop: Spacing.lg },
});
