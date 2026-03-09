import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function CustomerFormScreen({ route, navigation }) {
  const existing = route.params?.customer;
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.name || '');
  const [phone, setPhone] = useState(existing?.phone || '');
  const [email, setEmail] = useState(existing?.email || '');
  const [birthday, setBirthday] = useState(existing?.birthday || '');
  const [anniversary, setAnniversary] = useState(existing?.anniversary || '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return Alert.alert('Error', 'Name is required');
    if (!phone.trim()) return Alert.alert('Error', 'Phone is required');
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        birthday: birthday.trim() || null,
        anniversary: anniversary.trim() || null,
        notes: notes.trim() || null,
      };
      if (isEdit) {
        await api.updateCustomer(existing.id, data);
      } else {
        await api.createCustomer(data);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save customer');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (label, value, onChange, opts = {}) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}{opts.required ? ' *' : ''}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={opts.placeholder || label}
        placeholderTextColor={Colors.textLight}
        keyboardType={opts.keyboard || 'default'}
        autoCapitalize={opts.capitalize || 'sentences'}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Basic Info</Text>
          {renderField('Name', name, setName, { required: true })}
          {renderField('Phone', phone, setPhone, { required: true, keyboard: 'phone-pad', capitalize: 'none' })}
          {renderField('Email', email, setEmail, { keyboard: 'email-address', capitalize: 'none' })}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Important Dates</Text>
          {renderField('Birthday', birthday, setBirthday, { placeholder: 'YYYY-MM-DD' })}
          {renderField('Anniversary', anniversary, setAnniversary, { placeholder: 'YYYY-MM-DD' })}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Customer preferences, allergies, etc."
            placeholderTextColor={Colors.textLight}
            multiline
            numberOfLines={3}
          />
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
        >
          <Ionicons name={isEdit ? 'checkmark' : 'person-add'} size={20} color={Colors.white} />
          <Text style={styles.saveText}>{saving ? 'Saving...' : isEdit ? 'Update Customer' : 'Add Customer'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  fieldGroup: { marginBottom: Spacing.sm },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.sm, color: Colors.text,
    borderWidth: 1, borderColor: Colors.border,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  saveBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginTop: Spacing.sm,
  },
  saveText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.white },
});
