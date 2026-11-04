import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import DateTimePickerModal from '../components/DateTimePickerModal';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert } from '../utils/alert';
import { getShopTodayStr, getShopNow } from '../utils/datetime';
import {
  addDaysStr, dateStrToDate, dateToDateStr, formatWeekdayDayMonth,
} from '../utils/helperAccess';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const QUICK_DAYS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
];

// Owner/manager: give someone short-term helper access (spec §8.3).
// Name, phone, Works until (default today + 7) and location → Create →
// the join QR screen.
export default function AddHelperScreen({ navigation }) {
  const { settings, activeLocation } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [worksUntil, setWorksUntil] = useState(addDaysStr(today, 7));
  const [showPicker, setShowPicker] = useState(false);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState(activeLocation?.id || null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const guardSubmit = useSubmitGuard();

  useEffect(() => {
    let alive = true;
    api.getLocations()
      .then((res) => {
        if (!alive) return;
        const list = (res.data?.locations || []).filter((l) => l.is_active !== 0 && l.is_active !== false);
        setLocations(list);
        setLocationId((cur) => (cur && list.some((l) => l.id === cur) ? cur : list[0]?.id || null));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = "Type the helper's name.";
    if (!/^[6-9]\d{9}$/.test(phone.trim())) e.phone = 'Type a 10-digit mobile number.';
    if (!locationId) e.location = 'Pick where they will work.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleCreate = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const res = await api.createUser({
        name: name.trim(),
        phone: phone.trim(),
        role: 'helper',
        access_until: worksUntil,
        location_ids: [locationId],
      });
      const helper = res.data?.user;
      navigation.replace('HelperJoinQR', { helper });
    } catch (err) {
      const first = Array.isArray(err?.errors) && err.errors[0]?.msg;
      showAlert("Couldn't add the helper", first || err?.message || 'Check the internet and tap Create again.');
    } finally {
      setSaving(false);
    }
  };

  const clearError = (field) => {
    if (errors[field]) setErrors({ ...errors, [field]: null });
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>
            A helper can sell from the catalog on their own phone until the date you pick. They sign in with a PIN they set themselves.
          </Text>

          <Input
            label="Name"
            value={name}
            onChangeText={(t) => { setName(t); clearError('name'); }}
            placeholder="Helper's name"
            autoCapitalize="words"
            error={errors.name}
            leftIcon={<Ionicons name="person-outline" size={20} color={Colors.textSecondary} />}
          />

          <Input
            label="Phone"
            value={phone}
            onChangeText={(t) => { setPhone(t.replace(/[^0-9]/g, '').slice(0, 10)); clearError('phone'); }}
            placeholder="10-digit mobile number"
            keyboardType="phone-pad"
            maxLength={10}
            error={errors.phone}
            leftIcon={<Ionicons name="call-outline" size={20} color={Colors.textSecondary} />}
          />

          <Text style={styles.label}>Works until</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => setShowPicker(true)}
            accessibilityRole="button"
            accessibilityLabel={`Works until ${formatWeekdayDayMonth(worksUntil)}. Tap to change.`}
          >
            <Ionicons name="calendar-outline" size={22} color={Colors.primary} />
            <Text style={styles.dateText}>{formatWeekdayDayMonth(worksUntil)}</Text>
            <Text style={styles.dateChange}>Change</Text>
          </TouchableOpacity>
          <View style={styles.chipRow}>
            {QUICK_DAYS.map((q) => {
              const value = addDaysStr(today, q.days);
              const on = value === worksUntil;
              return (
                <TouchableOpacity
                  key={q.days}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setWorksUntil(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{q.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.hint}>They can work all of that day.</Text>

          {locations.length > 1 ? (
            <>
              <Text style={styles.label}>Works at</Text>
              <View style={styles.chipRow}>
                {locations.map((l) => {
                  const on = l.id === locationId;
                  return (
                    <TouchableOpacity
                      key={l.id}
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() => { setLocationId(l.id); clearError('location'); }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : locations.length === 1 ? (
            <Text style={styles.locationLine}>
              <Ionicons name="location-outline" size={16} color={Colors.textSecondary} /> Works at {locations[0].name}
            </Text>
          ) : null}
          {!!errors.location && <Text style={styles.error}>{errors.location}</Text>}

          <Button
            title="Create"
            size="lg"
            onPress={guardSubmit(handleCreate)}
            loading={saving}
            style={styles.primary}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <DateTimePickerModal
        visible={showPicker}
        mode="date"
        value={dateStrToDate(worksUntil)}
        minimumDate={getShopNow(timezone)}
        title="Works until"
        onCancel={() => setShowPicker(false)}
        onConfirm={(d) => {
          setShowPicker(false);
          const picked = dateToDateStr(d);
          setWorksUntil(picked < today ? today : picked);
        }}
      />
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.lg, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 560, alignSelf: 'center' },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 22 },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.sm },
  dateButton: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    minHeight: 52, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  dateText: { flex: 1, fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  dateChange: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '500' },
  chipTextOn: { color: Colors.white },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm },
  locationLine: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.lg },
  error: { fontSize: FontSize.sm, color: Colors.error, marginTop: Spacing.xs },
  primary: { marginTop: Spacing.xl },
});
