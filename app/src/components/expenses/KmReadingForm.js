/**
 * KmReadingForm: a rider's bike meter reading, shown inside the Add expense
 * sheet in place (like MoneyToStaffForm). Spec 2026-11-15 rider km account §7.
 *
 *   ‹  Km reading                                   ✕
 *   Rider              (Lakshman) (Ravi)
 *   [ Arriving | Going home ]
 *   Meter              [ 12386 ]
 *   Last: Arriving 12,340 · 9:12 am     → 46 km of work
 *   For another day ›            Type km instead ›
 *   [            Save reading            ]
 *
 * Common case: Add expense → Km reading → rider → type the meter → Save
 * (3 taps and one typed number; the meter box takes focus after the rider).
 *
 * Props: locationId, onBack(), onClose(), onDone({ expense: null, removed: false, message }),
 *        closeRequest (bumps when the modal asks to close),
 *        presetRider? { id, name } (the rider is fixed, as on the rider km screen),
 *        startOn? a Date: open in "For another day" with the date picker on that day
 *        (Add the missed readings for a gap).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../../utils/alert';
import { suggestKind, workKmText, clockText, readAtFor, clampToNow } from '../../utils/riderKm';
import DateTimePickerModal from '../DateTimePickerModal';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const LAST_RIDER_KEY = '@petal_last_km_rider';
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localDateTime = (d) => `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const num = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
const KIND_WORDS = { arrive: 'Arriving', leave: 'Going home', typed: 'Km of work' };

export default function KmReadingForm({ locationId, onBack, onClose, onDone, closeRequest, presetRider, startOn }) {
  const [riders, setRiders] = useState([]);
  const [ridersState, setRidersState] = useState('loading');
  const [rider, setRider] = useState(null); // { id, name }
  const [last, setLast] = useState(null);
  const [kind, setKind] = useState('arrive');
  const [kindTouched, setKindTouched] = useState(false);
  const [typedMode, setTypedMode] = useState(false);
  const [meter, setMeter] = useState('');
  const [typedKm, setTypedKm] = useState('');
  const [when, setWhen] = useState(null); // a Date picked under For another day
  const [pickDate, setPickDate] = useState(!!startOn);
  const [pickTime, setPickTime] = useState(false);
  const [pendingDate, setPendingDate] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [lastFailed, setLastFailed] = useState(false);
  const riderReq = useRef(0);
  const meterRef = useRef(null);
  const scrollRef = useRef(null);

  // Riders, with the one used last first.
  const loadRiders = async () => {
    setRidersState('loading');
    try {
      const res = await api.getKmRiders(locationId);
      // A rider who has left is listed only for the final settlement.
      let list = (res.data || []).filter((r) => r.is_active !== false);
      let lastId = null;
      try { lastId = Number(await AsyncStorage.getItem(LAST_RIDER_KEY)); } catch { /* none remembered */ }
      if (lastId) list = [...list.filter((r) => Number(r.id) === lastId), ...list.filter((r) => Number(r.id) !== lastId)];
      setRiders(list);
      setRidersState('ready');
    } catch {
      setRidersState('error');
    }
  };
  useEffect(() => {
    if (presetRider) {
      setRiders([presetRider]);
      setRidersState('ready');
      pickRider(presetRider);
      return;
    }
    if (locationId) loadRiders();
  }, [locationId, presetRider && presetRider.id]);

  const pickRider = (r) => {
    setRider({ id: Number(r.id), name: r.name });
    setErrors((e) => ({ ...e, rider: undefined }));
    setLast(null);
    setLastFailed(false);
    const req = ++riderReq.current;
    api.getRiderKm(r.id)
      .then((res) => {
        if (req !== riderReq.current) return; // another rider was picked since
        const lr = res.data?.last_reading || null;
        setLast(lr);
        if (!kindTouched) setKind(suggestKind(lr));
      })
      .catch(() => { if (req === riderReq.current) setLastFailed(true); });
    if (!startOn) setTimeout(() => (typedMode ? null : meterRef.current?.focus()), 50);
  };

  const dirty = (!!rider && !presetRider) || meter !== '' || typedKm !== '';
  const leave = (then) => {
    if (saving) return;
    if (!dirty) { then(); return; }
    showConfirm('Leave without saving?', 'What you typed here will be lost.', then,
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };
  const firstClose = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest !== firstClose.current) leave(onClose);
  }, [closeRequest]);

  const buildBody = () => {
    const body = { location_id: locationId, user_id: rider.id };
    if (typedMode) { body.kind = 'typed'; body.typed_km = typedKm; } else { body.kind = kind; body.meter = meter; }
    const readAt = readAtFor({ typedMode, when });
    if (readAt) body.read_at = readAt;
    return body;
  };

  const send = async (confirmBig) => {
    setSaving(true);
    try {
      const body = buildBody();
      if (confirmBig) body.confirm_big = true;
      const res = await api.addKmReading(body);
      setSaving(false);
      try { await AsyncStorage.setItem(LAST_RIDER_KEY, String(rider.id)); } catch { /* not remembered */ }
      const km = Number(res.data?.today_work_km) || 0;
      const message = km > 0
        ? `Saved · ${num(km)} km of work today`
        : `Saved · ${typedMode ? 'Km of work' : KIND_WORDS[kind]}`;
      onDone && onDone({ expense: null, removed: false, message });
    } catch (err) {
      setSaving(false);
      if (err && err.code === 'CONFIRM_BIG') {
        showConfirm('Check the meter', err.raw_message || err.message, () => { send(true); },
          { confirmLabel: 'Yes, save it', cancelLabel: 'No, fix it' });
        return;
      }
      showAlert('Reading not saved', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  };

  const guard = useSubmitGuard();
  const handleSave = async () => {
    const e = {};
    if (!rider) e.rider = 'Pick the rider from the list so it counts against their km.';
    if (typedMode) {
      if (!/^\d+(\.\d)?$/.test(typedKm.trim()) || Number(typedKm) <= 0) e.km = 'Type the km of work, like 24.';
    } else if (!/^\d+(\.\d+)?$/.test(meter.trim())) e.meter = 'Type the number shown on the bike meter, like 12345.';
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.meter || e.km) setTimeout(() => meterRef.current?.focus(), 50);
      return;
    }
    await send(false);
  };

  const work = typedMode ? null : workKmText(last, meter.trim());
  const lastLine = last && last.kind !== 'typed' && last.meter != null
    ? `Last: ${KIND_WORDS[last.kind] || ''} ${Number(last.meter).toLocaleString('en-IN')} · ${clockText(last.read_at)}`
    : null;

  return (
    <>
      <View style={styles.header}>
        {!!onBack && (
          <TouchableOpacity onPress={() => leave(onBack)} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back to Add expense">
            <Ionicons name="chevron-back" size={26} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}
        <Text style={styles.title}>Km reading</Text>
        <TouchableOpacity onPress={() => leave(onClose)} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView ref={scrollRef} style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Rider</Text>
        <View style={styles.chips}>
          {riders.map((r) => {
            const active = !!rider && rider.id === Number(r.id);
            return (
              <TouchableOpacity
                key={r.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => pickRider(r)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Km reading for ${r.name}`}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{r.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {ridersState === 'loading' && <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.sm }} />}
        {ridersState === 'error' && (
          <TouchableOpacity onPress={loadRiders} style={styles.retry} accessibilityRole="button">
            <Text style={styles.error}>Could not load the riders. Tap to try again.</Text>
          </TouchableOpacity>
        )}
        {ridersState === 'ready' && riders.length === 0 && (
          <Text style={styles.hint}>No riders are linked to this shop yet. The owner can add them under Staff.</Text>
        )}
        {!!errors.rider && <Text style={styles.error}>{errors.rider}</Text>}

        {!typedMode && (
          <View style={styles.kindRow} accessibilityRole="radiogroup">
            {['arrive', 'leave'].map((k) => {
              const active = kind === k;
              return (
                <TouchableOpacity
                  key={k}
                  style={[styles.kindBtn, active && styles.kindBtnActive]}
                  onPress={() => { setKind(k); setKindTouched(true); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.kindText, active && styles.kindTextActive]}>{KIND_WORDS[k]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={styles.label}>{typedMode ? 'Km of work' : 'Meter'}</Text>
        <View style={[styles.amountBox, (errors.meter || errors.km) && styles.inputError]}>
          <TextInput
            ref={meterRef}
            style={styles.amountInput}
            value={typedMode ? typedKm : meter}
            onChangeText={(t) => {
              const v = t.replace(/[^0-9.]/g, '');
              if (typedMode) setTypedKm(v); else setMeter(v);
              setErrors((x) => ({ ...x, meter: undefined, km: undefined }));
            }}
            placeholder="0"
            placeholderTextColor={Colors.textLight}
            keyboardType="decimal-pad"
            returnKeyType="done"
            accessibilityLabel={typedMode ? 'Km of work' : 'Meter reading'}
          />
          {typedMode && <Text style={styles.unit}>km</Text>}
        </View>
        {!!errors.meter && <Text style={styles.error}>{errors.meter}</Text>}
        {!!errors.km && <Text style={styles.error}>{errors.km}</Text>}
        {!typedMode && !!lastLine && <Text style={styles.hint}>{lastLine}</Text>}
        {!typedMode && lastFailed && <Text style={styles.hint}>Couldn't load the last reading. You can still save.</Text>}
        {!!work && <Text style={styles.work}>{work}</Text>}

        <View style={styles.linksRow}>
          <TouchableOpacity
            style={styles.link}
            onPress={() => (when ? setWhen(null) : setPickDate(true))}
            accessibilityRole="button"
            accessibilityLabel={when ? 'Back to now' : 'For another day'}
          >
            <Text style={styles.linkText}>
              {when ? `${dayText(when)}${typedMode ? '' : ` ${clockText(localDateTime(when))}`} · Back to now ›` : 'For another day ›'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.link}
            onPress={() => { setTypedMode((v) => !v); setErrors({}); setTimeout(() => meterRef.current?.focus(), 50); }}
            accessibilityRole="button"
          >
            <Text style={styles.linkText}>{typedMode ? 'Type the meter instead ›' : 'Type km instead ›'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <TouchableOpacity
        style={[styles.saveBtn, saving && { opacity: 0.6 }]}
        onPress={guard(handleSave)}
        disabled={saving}
        accessibilityRole="button"
        accessibilityState={{ disabled: saving }}
      >
        {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveText}>Save reading</Text>}
      </TouchableOpacity>

      <DateTimePickerModal
        visible={pickDate}
        mode="date"
        value={when || startOn || new Date()}
        maximumDate={new Date()}
        title="Which day was it?"
        onCancel={() => setPickDate(false)}
        onConfirm={(d) => {
          setPickDate(false);
          if (typedMode) { setWhen(d); return; }
          setPendingDate(d);
          setPickTime(true);
        }}
      />
      <DateTimePickerModal
        visible={pickTime}
        mode="time"
        value={pendingDate || new Date()}
        title="What time was the reading?"
        onCancel={() => setPickTime(false)}
        onConfirm={(t) => {
          setPickTime(false);
          const d = new Date(pendingDate || new Date());
          d.setHours(t.getHours(), t.getMinutes(), 0, 0);
          setWhen(clampToNow(d));
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  backBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-start', justifyContent: 'center' },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  scroll: { flexGrow: 0 },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm },
  chip: {
    minHeight: 48, maxWidth: 180, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  retry: { minHeight: 44, justifyContent: 'center' },
  kindRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  kindBtn: {
    flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  kindBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  kindText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  kindTextActive: { color: Colors.white, fontWeight: '800' },
  amountBox: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56,
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, backgroundColor: Colors.background,
  },
  inputError: { borderColor: Colors.error },
  amountInput: { flex: 1, minHeight: 54, fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  unit: { fontSize: FontSize.lg, color: Colors.textSecondary, marginLeft: Spacing.xs },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  hint: { color: Colors.textSecondary, fontSize: FontSize.md, marginTop: Spacing.xs },
  work: { color: Colors.text, fontSize: FontSize.md, fontWeight: '700', marginTop: Spacing.xs },
  linksRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: Spacing.sm, marginTop: Spacing.sm },
  link: { minHeight: 48, justifyContent: 'center' },
  linkText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  saveBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: Spacing.md,
  },
  saveText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
});
