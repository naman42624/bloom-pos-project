/**
 * SoldByPicker — "Sold by: You ▸" row. Tap to see colleague chips.
 * value: null (= You, the logged-in user) or a user id. Default needs zero taps.
 * Roster failure never blocks an order: the row simply stays on "You".
 */
import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius, TouchTarget } from '../constants/theme';

export default function SoldByPicker({ locationId, value, onChange }) {
  const { user } = useAuth();
  const [staff, setStaff] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!locationId) { setStaff([]); return undefined; }
    api.getStaffRoster(locationId)
      .then((res) => {
        if (!alive) return;
        setStaff((res?.data?.staff || []).filter((s) => s.id !== user?.id));
      })
      .catch(() => { if (alive) setStaff([]); });
    return () => { alive = false; };
  }, [locationId, user?.id]);

  // A pick that is not on this location's list (location changed) goes back to You,
  // so the row never says "You" while sending someone else.
  useEffect(() => {
    if (value != null && !staff.some((s) => s.id === value)) onChange(null);
  }, [staff, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Staff';
  // Two people with the same first name get their full names.
  const shortName = (n) => {
    const f = firstName(n);
    return staff.filter((s) => firstName(s.name) === f).length > 1 ? String(n).trim() : f;
  };
  const picked = value == null ? null : staff.find((s) => s.id === value);
  const label = picked ? shortName(picked.name) : 'You';

  if (staff.length === 0 && value == null) return null;

  const choose = (id) => { onChange(id); setOpen(false); };

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Sold by ${label}. Tap to change.`}
      >
        <Text style={styles.rowText}>{`Sold by: ${label} ${open ? '▾' : '▸'}`}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.chips}>
          <TouchableOpacity
            style={[styles.chip, value == null && styles.chipActive]}
            onPress={() => choose(null)}
            accessibilityRole="button"
            accessibilityState={{ selected: value == null }}
          >
            <Text style={[styles.chipText, value == null && styles.chipTextActive]}>Me</Text>
          </TouchableOpacity>
          {staff.map((s) => (
            <TouchableOpacity
              key={s.id}
              style={[styles.chip, value === s.id && styles.chipActive]}
              onPress={() => choose(s.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: value === s.id }}
            >
              <Text style={[styles.chipText, value === s.id && styles.chipTextActive]}>{shortName(s.name)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: Spacing.sm },
  row: { minHeight: TouchTarget.minHeight, justifyContent: 'center', paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white },
  rowText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: Spacing.sm },
  chip: { minHeight: 48, minWidth: 72, paddingHorizontal: Spacing.md, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white, marginRight: Spacing.sm, marginBottom: Spacing.sm },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  chipTextActive: { color: Colors.white },
});
