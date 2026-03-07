import React, { useState } from 'react';
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
import { useAuth } from '../context/AuthContext';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function SetupScreen({ navigation }) {
  const { ownerSetup } = useAuth();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Name is required';
    if (!phone.trim()) newErrors.phone = 'Phone number is required';
    else if (!/^[6-9]\d{9}$/.test(phone.trim())) newErrors.phone = 'Enter a valid 10-digit Indian mobile number';
    if (!password) newErrors.password = 'Password is required';
    else if (password.length < 6) newErrors.password = 'Password must be at least 6 characters';
    if (password !== confirmPassword) newErrors.confirmPassword = 'Passwords do not match';
    if (!businessName.trim()) newErrors.businessName = 'Business name is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSetup = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      await ownerSetup({
        name: name.trim(),
        phone: phone.trim(),
        password,
        shopName: businessName.trim(),
      });
    } catch (err) {
      Alert.alert('Setup Failed', err.message || 'Please try again.');
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
        bounces={false}
      >
        <View style={styles.header}>
          <View style={styles.iconContainer}>
            <Ionicons name="flower" size={64} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Welcome to BloomCart</Text>
          <Text style={styles.subtitle}>Set up your flower shop POS</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Business Details</Text>
          <Input
            label="Business Name"
            value={businessName}
            onChangeText={(t) => { setBusinessName(t); clearError('businessName'); }}
            placeholder="e.g. Rose Garden Florist"
            autoCapitalize="words"
            error={errors.businessName}
            leftIcon={<Ionicons name="storefront-outline" size={20} color={Colors.textSecondary} />}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Owner Account</Text>
          <Input
            label="Full Name"
            value={name}
            onChangeText={(t) => { setName(t); clearError('name'); }}
            placeholder="Your full name"
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
            leftIcon={<Ionicons name="call-outline" size={20} color={Colors.textSecondary} />}
          />
          <Input
            label="Password"
            value={password}
            onChangeText={(t) => { setPassword(t); clearError('password'); }}
            placeholder="At least 6 characters"
            secureTextEntry
            error={errors.password}
            leftIcon={<Ionicons name="lock-closed-outline" size={20} color={Colors.textSecondary} />}
          />
          <Input
            label="Confirm Password"
            value={confirmPassword}
            onChangeText={(t) => { setConfirmPassword(t); clearError('confirmPassword'); }}
            placeholder="Re-enter your password"
            secureTextEntry
            error={errors.confirmPassword}
            leftIcon={<Ionicons name="lock-closed-outline" size={20} color={Colors.textSecondary} />}
          />
        </View>

        <Button
          title="Complete Setup"
          onPress={handleSetup}
          loading={loading}
          style={styles.setupButton}
        />

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already set up?</Text>
          <Text style={styles.footerLink} onPress={() => navigation.navigate('Login')}>
            {' '}Sign In
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { flexGrow: 1, padding: Spacing.lg, paddingTop: 60 },
  header: { alignItems: 'center', marginBottom: Spacing.xl },
  iconContainer: { marginBottom: Spacing.md },
  title: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text },
  subtitle: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  section: { marginBottom: Spacing.lg },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  setupButton: { marginTop: Spacing.sm, marginBottom: Spacing.lg },
  footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  footerText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  footerLink: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
});
