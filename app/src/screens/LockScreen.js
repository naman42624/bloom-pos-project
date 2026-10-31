import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function LockScreen({ navigation }) {
  const { staffLogin, getDeviceLocationId, user } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locationId, setLocationId] = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    try {
      // Prefer the currently-locked user's own location if we have one
      // (they were just using this device); otherwise fall back to
      // whatever location this device last saw during any login.
      const locId = user?.locations?.[0]?.id || (await getDeviceLocationId());
      if (!locId) {
        setStaff([]);
        setLoading(false);
        return;
      }
      setLocationId(locId);
      const res = await api.getStaffRoster(locId);
      setStaff(res.data?.staff || []);
    } catch {
      setStaff([]);
    } finally {
      setLoading(false);
    }
  }, [user, getDeviceLocationId]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  // The PIN lives in a ref as well as state: quick taps (or keys) can land
  // before React re-renders, and reading `pin` from state then dropped digits.
  const pinRef = useRef('');
  const submittingRef = useRef(false);
  const updatePin = (next) => { pinRef.current = next; setPin(next); };

  const submitPin = async (fullPin) => {
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await staffLogin(selectedStaff.employee_code, fullPin);
      // AuthContext's LOGIN action already flips locked:false — nothing
      // else to do here, RootNavigator swaps to MainNavigator on its own.
    } catch (err) {
      setError(err.message || 'Something went wrong');
      updatePin('');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleDigit = (d) => {
    if (pinRef.current.length >= 4 || submittingRef.current) return;
    const next = pinRef.current + d;
    updatePin(next);
    setError('');
    if (next.length === 4) submitPin(next);
  };

  const handleBackspace = () => {
    if (submittingRef.current) return;
    updatePin(pinRef.current.slice(0, -1));
  };

  const leavePin = () => { setSelectedStaff(null); updatePin(''); setError(''); };

  // A counter computer has a keyboard: digits type the PIN, Backspace deletes,
  // Escape goes back to the staff list.
  const keyHandlerRef = useRef(null);
  keyHandlerRef.current = (e) => {
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); handleDigit(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); handleBackspace(); }
    else if (e.key === 'Escape') { leavePin(); }
  };
  useEffect(() => {
    if (Platform.OS !== 'web' || !selectedStaff || typeof window === 'undefined') return undefined;
    const onKey = (e) => keyHandlerRef.current && keyHandlerRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStaff]);

  if (selectedStaff) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backLink} onPress={leavePin} accessibilityRole="button">
          <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          <Text style={styles.backLinkText}>Not {selectedStaff.name}?</Text>
        </TouchableOpacity>
        <Text style={styles.pinTitle}>{selectedStaff.name} — enter PIN</Text>
        <View style={styles.pinDots}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.pinDot, i < pin.length && styles.pinDotFilled]} />
          ))}
        </View>
        {/* Fixed-height line for the message or spinner, so the keypad never
            moves under a finger mid-entry. */}
        <View style={styles.statusLine}>
          {submitting
            ? <ActivityIndicator color={Colors.primary} />
            : error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
        <View style={[styles.keypad, submitting && { opacity: 0.4 }]}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
            <TouchableOpacity
              key={i}
              style={styles.keypadKey}
              disabled={k === '' || submitting}
              onPress={() => (k === '⌫' ? handleBackspace() : k !== '' && handleDigit(k))}
              accessibilityRole="button"
              accessibilityLabel={k === '⌫' ? 'Delete last digit' : k || undefined}
            >
              <Text style={styles.keypadKeyText}>{k}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {Platform.OS === 'web' ? (
          <Text style={styles.keyboardHint}>You can also type your PIN on the keyboard.</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Who's working?</Text>
      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xl }} />
      ) : staff.length === 0 ? (
        <Text style={styles.emptyText}>
          No staff set up for shared-device login yet. Ask your manager to set this up, or use owner/manager login below.
        </Text>
      ) : (
        <FlatList
          data={staff}
          numColumns={2}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.tileGrid}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.tile} onPress={() => setSelectedStaff(item)}>
              {item.avatar ? (
                <Image source={{ uri: api.getMediaUrl(item.avatar) }} style={styles.tileAvatar} />
              ) : (
                <View style={styles.tileAvatarPlaceholder}>
                  <Ionicons name="person" size={32} color={Colors.textLight} />
                </View>
              )}
              <Text style={styles.tileName}>{item.name}</Text>
              {item.job_title ? <Text style={styles.tileJobTitle}>{item.job_title}</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
      <TouchableOpacity style={styles.ownerLoginLink} onPress={() => navigation.navigate('Login')} accessibilityRole="button">
        <Text style={styles.ownerLoginLinkText}>Owner / Manager login</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, padding: Spacing.lg, justifyContent: 'center' },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.lg },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xl },
  tileGrid: { paddingVertical: Spacing.md },
  tile: { flex: 1, alignItems: 'center', margin: Spacing.sm, padding: Spacing.lg, backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, minHeight: 140, justifyContent: 'center' },
  tileAvatar: { width: 64, height: 64, borderRadius: 32, marginBottom: Spacing.sm },
  tileAvatarPlaceholder: { width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  tileName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  tileJobTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  ownerLoginLink: {
    marginTop: Spacing.xl, alignSelf: 'center', minHeight: 48, paddingHorizontal: Spacing.lg,
    justifyContent: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  ownerLoginLinkText: { color: Colors.text, fontSize: FontSize.md, fontWeight: '600' },
  backLink: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', minHeight: 48, paddingRight: Spacing.md, marginBottom: Spacing.lg },
  backLinkText: { color: Colors.textSecondary, fontSize: FontSize.md, marginLeft: 4 },
  pinTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.lg },
  pinDots: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: Spacing.md },
  pinDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: Colors.border },
  pinDotFilled: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  statusLine: { minHeight: 28, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  errorText: { color: Colors.error, textAlign: 'center', fontSize: FontSize.md },
  keyboardHint: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.md },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.lg, maxWidth: 320, alignSelf: 'center' },
  keypadKey: { width: 90, height: 70, justifyContent: 'center', alignItems: 'center' },
  keypadKeyText: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.text },
});
