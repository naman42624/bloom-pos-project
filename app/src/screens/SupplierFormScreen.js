import React, { useState, useEffect } from 'react';
import {
  View, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, Alert,
} from 'react-native';
import api from '../services/api';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, Spacing } from '../constants/theme';

export default function SupplierFormScreen({ route, navigation }) {
  const existing = route.params?.supplier;
  const isEditing = !!existing;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (existing) {
      setName(existing.name || '');
      setPhone(existing.phone || '');
      setEmail(existing.email || '');
      setAddress(existing.address || '');
      setGstNumber(existing.gst_number || '');
      setNotes(existing.notes || '');
    }
  }, [existing]);

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Supplier name is required';
    if (phone && !/^[6-9]\d{9}$/.test(phone.trim())) e.phone = 'Enter a valid 10-digit number';
    if (email && !/^\S+@\S+\.\S+$/.test(email.trim())) e.email = 'Enter a valid email';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        gst_number: gstNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      if (isEditing) {
        await api.updateSupplier(existing.id, data);
      } else {
        await api.createSupplier(data);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save supplier');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Input label="Supplier Name" value={name} onChangeText={setName} error={errors.name} placeholder="e.g. Krishna Flowers" />
          <Input label="Phone" value={phone} onChangeText={setPhone} error={errors.phone} keyboardType="phone-pad" placeholder="10-digit mobile" />
          <Input label="Email (optional)" value={email} onChangeText={setEmail} error={errors.email} keyboardType="email-address" placeholder="supplier@email.com" autoCapitalize="none" />
          <Input label="Address (optional)" value={address} onChangeText={setAddress} placeholder="Full address" multiline />
          <Input label="GST Number (optional)" value={gstNumber} onChangeText={setGstNumber} placeholder="GST number" autoCapitalize="characters" />
          <Input label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Any notes about this supplier" multiline />

          <View style={styles.actions}>
            <Button title={isEditing ? 'Update Supplier' : 'Add Supplier'} onPress={handleSubmit} loading={loading} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  actions: { marginTop: Spacing.xl },
});
