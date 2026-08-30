import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert } from 'react-native';
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

  const handleDigit = (d) => {
    if (pin.length >= 4 || submitting) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) submitPin(next);
  };

  const handleBackspace = () => setPin((p) => p.slice(0, -1));

  const submitPin = async (fullPin) => {
    setSubmitting(true);
    try {
      await staffLogin(selectedStaff.employee_code, fullPin);
      // AuthContext's LOGIN action already flips locked:false — nothing
      // else to do here, RootNavigator swaps to MainNavigator on its own.
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  if (selectedStaff) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backLink} onPress={() => { setSelectedStaff(null); setPin(''); setError(''); }}>
          <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          <Text style={styles.backLinkText}>Not {selectedStaff.name}?</Text>
        </TouchableOpacity>
        <Text style={styles.pinTitle}>{selectedStaff.name} — enter PIN</Text>
        <View style={styles.pinDots}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.pinDot, i < pin.length && styles.pinDotFilled]} />
          ))}
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {submitting ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.lg }} />
        ) : (
          <View style={styles.keypad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
              <TouchableOpacity
                key={i}
                style={styles.keypadKey}
                disabled={k === ''}
                onPress={() => (k === '⌫' ? handleBackspace() : k !== '' && handleDigit(k))}
              >
                <Text style={styles.keypadKeyText}>{k}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
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
      <TouchableOpacity style={styles.ownerLoginLink} onPress={() => navigation.navigate('Login')}>
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
  ownerLoginLink: { marginTop: Spacing.xl, alignSelf: 'center' },
  ownerLoginLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm, textDecorationLine: 'underline' },
  backLink: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  backLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm, marginLeft: 4 },
  pinTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.lg },
  pinDots: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: Spacing.md },
  pinDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: Colors.border },
  pinDotFilled: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  errorText: { color: Colors.error, textAlign: 'center', marginBottom: Spacing.sm },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.lg, maxWidth: 320, alignSelf: 'center' },
  keypadKey: { width: 90, height: 70, justifyContent: 'center', alignItems: 'center' },
  keypadKeyText: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.text },
});
