import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { showAlert } from '../utils/alert';
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
  const [shopState, setShopState] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [fssai, setFssai] = useState('');
  const [invoicePrefix, setInvoicePrefix] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [geofenceRadius, setGeofenceRadius] = useState('50');
  const [loading, setLoading] = useState(false);
  const [fetchingLocation, setFetchingLocation] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (existingLocation) {
      setName(existingLocation.name || '');
      setType(existingLocation.type || 'shop');
      setAddress(existingLocation.address || '');
      setPhone(existingLocation.phone || '');
      setGstNumber(existingLocation.gst_number || '');
      setShopState(existingLocation.state || '');
      setStateCode(existingLocation.state_code || '');
      setFssai(existingLocation.fssai_number || '');
      setInvoicePrefix(existingLocation.invoice_prefix || '');
      setLatitude(existingLocation.latitude != null ? String(existingLocation.latitude) : '');
      setLongitude(existingLocation.longitude != null ? String(existingLocation.longitude) : '');
      setGeofenceRadius(String(existingLocation.geofence_radius || 50));
    }
  }, [existingLocation]);

  const validate = () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Location name is required';
    if (phone && !/^[6-9]\d{9}$/.test(phone.trim())) newErrors.phone = 'Enter a valid 10-digit number';
    if (latitude && (isNaN(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90))
      newErrors.latitude = 'Must be between -90 and 90';
    if (longitude && (isNaN(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180))
      newErrors.longitude = 'Must be between -180 and 180';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const useCurrentLocation = async () => {
    setFetchingLocation(true);
    try {
      const loc = await import('expo-location');
      const { status } = await loc.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        showAlert('Location is off', 'Allow location for this app in your phone settings, or type the coordinates below.');
        return;
      }
      const position = await loc.getCurrentPositionAsync({ accuracy: loc.Accuracy.High });
      setLatitude(String(position.coords.latitude));
      setLongitude(String(position.coords.longitude));
      clearError('latitude');
      clearError('longitude');
    } catch (e) {
      showAlert('Could not find you', 'Type the coordinates below instead.');
    } finally {
      setFetchingLocation(false);
    }
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
        // Sent even when empty, so a GSTIN or FSSAI can be cleared
        gst_number: gstNumber.trim(),
        state: shopState.trim() || undefined,
        state_code: stateCode.trim(),
        fssai_number: fssai.trim(),
        invoice_prefix: invoicePrefix.trim(),
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
        geofence_radius: parseInt(geofenceRadius, 10) || 50,
      };

      if (isEditing) {
        await api.updateLocation(existingLocation.id, data);
      } else {
        await api.createLocation(data);
      }

      navigation.goBack();
    } catch (err) {
      showAlert('Could not save', err.message || 'The shop was not saved. Check the details and try again.');
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

        {/* Bill details: printed on this shop's tax invoices */}
        <Text style={styles.sectionTitle}>Bill details</Text>
        <Text style={styles.sectionDesc}>
          Printed on this shop's bills. With a GSTIN, bills print as a TAX INVOICE.
        </Text>
        <Input
          label="GSTIN"
          value={gstNumber}
          onChangeText={(t) => { setGstNumber(t.toUpperCase()); if (!stateCode && /^\d{2}/.test(t)) setStateCode(t.slice(0, 2)); }}
          placeholder="Like 07ABCDE1234F1Z5 (leave empty if none)"
          autoCapitalize="characters"
          maxLength={15}
          leftIcon={<Ionicons name="document-text-outline" size={20} color={Colors.textSecondary} />}
        />
        <Input
          label="State"
          value={shopState}
          onChangeText={setShopState}
          placeholder="Like Delhi"
          leftIcon={<Ionicons name="map-outline" size={20} color={Colors.textSecondary} />}
        />
        <Input
          label="State code"
          value={stateCode}
          onChangeText={(t) => setStateCode(t.replace(/\D/g, '').slice(0, 2))}
          placeholder="2 numbers, like 07 (filled from the GSTIN)"
          keyboardType="number-pad"
          maxLength={2}
        />
        <Input
          label="FSSAI number"
          value={fssai}
          onChangeText={(t) => setFssai(t.replace(/\D/g, '').slice(0, 14))}
          placeholder="Optional, 14 numbers"
          keyboardType="number-pad"
          maxLength={14}
        />
        <Input
          label="Bill number start"
          value={invoicePrefix}
          onChangeText={(t) => setInvoicePrefix(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
          placeholder="Optional, like FP1 (each shop needs its own)"
          autoCapitalize="characters"
          maxLength={5}
        />

        {/* Geolocation Section */}
        <Text style={styles.sectionTitle}>Geolocation</Text>
        <Text style={styles.sectionDesc}>
          Set coordinates for geofence-based auto attendance. Tap "Use Current Location" while at the location.
        </Text>

        <TouchableOpacity
          style={styles.currentLocationBtn}
          onPress={useCurrentLocation}
          disabled={fetchingLocation}
        >
          {fetchingLocation ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Ionicons name="navigate" size={18} color={Colors.primary} />
          )}
          <Text style={styles.currentLocationText}>
            {fetchingLocation ? 'Getting location...' : 'Use Current Location'}
          </Text>
        </TouchableOpacity>

        <View style={styles.coordRow}>
          <View style={{ flex: 1 }}>
            <Input
              label="Latitude"
              value={latitude}
              onChangeText={(t) => { setLatitude(t); clearError('latitude'); }}
              placeholder="e.g. 28.6139"
              keyboardType="numeric"
              error={errors.latitude}
              leftIcon={<Ionicons name="compass-outline" size={20} color={Colors.textSecondary} />}
            />
          </View>
          <View style={{ width: Spacing.sm }} />
          <View style={{ flex: 1 }}>
            <Input
              label="Longitude"
              value={longitude}
              onChangeText={(t) => { setLongitude(t); clearError('longitude'); }}
              placeholder="e.g. 77.2090"
              keyboardType="numeric"
              error={errors.longitude}
              leftIcon={<Ionicons name="compass-outline" size={20} color={Colors.textSecondary} />}
            />
          </View>
        </View>

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
  sectionTitle: {
    fontSize: FontSize.md, fontWeight: '600', color: Colors.text,
    marginTop: Spacing.md, marginBottom: Spacing.xs,
  },
  sectionDesc: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    marginBottom: Spacing.md, lineHeight: 18,
  },
  currentLocationBtn: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primaryLight + '20',
    marginBottom: Spacing.md, gap: Spacing.xs,
  },
  currentLocationText: {
    fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600',
  },
  coordRow: { flexDirection: 'row' },
  submitButton: { marginTop: Spacing.lg },
});
