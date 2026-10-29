// Public, no-login page opened by scanning the QR on the shop copy of a
// delivery/pickup slip (spec 2026-10-28 §3.5). Like TrackingScreen, App.js
// renders this before AuthProvider/RootNavigator mount, so it must import
// nothing that depends on auth or navigation. It talks to /api/slip/:token
// through the unauthenticated api helpers only.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, TouchableOpacity, Image, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { formatShopDateLabel, formatTimeString } from '../utils/datetime';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

const POLL_MS = 15000; // server allows 60 requests a minute per address

function VoiceNote({ note, label }) {
  const src = api.getMediaUrl(note.url);
  const text = `${label}${note.duration_seconds ? ` (${note.duration_seconds}s)` : ''}`;
  return (
    <View style={styles.voiceRow}>
      <Ionicons name="mic" size={18} color={Colors.primary} />
      <Text style={styles.voiceLabel}>{text}</Text>
      {Platform.OS === 'web'
        ? React.createElement('audio', { controls: true, preload: 'none', src, style: { height: 40, maxWidth: '100%' } })
        : null}
      <TouchableOpacity onPress={() => openMedia(src)} accessibilityRole="link" style={styles.openLink}>
        <Text style={styles.openLinkText}>Open voice note</Text>
      </TouchableOpacity>
    </View>
  );
}

function openMedia(url) {
  if (!url) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  else Linking.openURL(url).catch(() => {});
}

// Tappable thumbnails; a tap opens the full-size photo.
function PhotoStrip({ photos }) {
  if (!photos || photos.length === 0) return null;
  return (
    <View style={styles.photoStrip}>
      {photos.map((p, i) => {
        const uri = api.getMediaUrl(p.url);
        return (
          <TouchableOpacity key={`${p.url}-${i}`} onPress={() => openMedia(uri)} accessibilityRole="imagebutton" accessibilityLabel="Open photo full size" activeOpacity={0.8}>
            <Image source={{ uri }} style={styles.stripPhoto} resizeMode="cover" />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function SlipScreen({ token }) {
  const [state, setState] = useState({ loading: true, data: null, errorKind: null });
  const [checked, setChecked] = useState({});   // sale_item_id -> bool
  const [readOnlyMsg, setReadOnlyMsg] = useState('');
  const [toast, setToast] = useState('');
  const busy = useRef(0); // taps in flight; polling pauses so it cannot undo a tick

  const applyChecklist = useCallback((cl) => {
    const m = {};
    ((cl && cl.items) || []).forEach((i) => { m[i.sale_item_id] = !!i.checked; });
    setChecked(m);
    setReadOnlyMsg(cl && cl.final ? (cl.final_message || 'This list can no longer be changed') : '');
  }, []);

  const load = useCallback(async (first) => {
    if (!first && busy.current > 0) return;
    try {
      const res = await api.getSlipPage(token);
      setState({ loading: false, data: res.data, errorKind: null });
      if (busy.current === 0) applyChecklist(res.data.checklist);
    } catch (err) {
      if (!first) return; // keep showing what we have if a refresh blips
      setState({ loading: false, data: null, errorKind: err?.status === 404 ? 'not_found' : (err?.status === 429 ? 'rate_limited' : 'server_error') });
    }
  }, [token, applyChecklist]);

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const toggle = async (saleItemId) => {
    if (readOnlyMsg) return;
    const next = !checked[saleItemId];
    setToast('');
    busy.current += 1;
    setChecked((p) => ({ ...p, [saleItemId]: next }));
    try {
      const res = await api.toggleSlipCheck(token, saleItemId, next);
      busy.current -= 1;
      if (busy.current === 0) applyChecklist(res.data);
    } catch (err) {
      busy.current -= 1;
      setChecked((p) => ({ ...p, [saleItemId]: !next }));
      if (err?.status === 409) {
        setReadOnlyMsg(err.message || 'This list can no longer be changed.');
      } else if (err?.status === 404) {
        setState({ loading: false, data: null, errorKind: 'not_found' });
      } else {
        setToast(err?.status === 429 ? 'Too many tries — please wait a minute and try again.' : "Couldn't save, try again");
      }
    }
  };

  if (state.loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }
  if (state.errorKind === 'not_found') {
    return (
      <View style={styles.center}>
        <Ionicons name="link-outline" size={48} color={Colors.textLight} />
        <Text style={styles.bigMsg}>This slip link has expired or is not valid. Ask the shop for a new slip.</Text>
      </View>
    );
  }
  if (state.errorKind === 'rate_limited') {
    return (
      <View style={styles.center}>
        <Ionicons name="time-outline" size={48} color={Colors.textLight} />
        <Text style={styles.bigMsg}>Too many tries — please wait a minute and try again.</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => { setState({ loading: true, data: null, errorKind: null }); load(true); }}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (state.errorKind === 'server_error') {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={48} color={Colors.textLight} />
        <Text style={styles.bigMsg}>We couldn't load this slip. Check your internet and try again.</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => { setState({ loading: true, data: null, errorKind: null }); load(true); }}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const d = state.data;
  const enabled = d.checklist && d.checklist.enabled;
  const total = d.items.length;
  const done = d.items.filter((i) => checked[i.sale_item_id]).length;
  const when = d.scheduled_date
    ? `${formatShopDateLabel(d.scheduled_date)}${d.scheduled_time ? `, ${formatTimeString(d.scheduled_time)}` : ''}`
    : '';

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.kicker}>{d.display_type}</Text>
        <Text style={styles.orderNo}>Order {d.order_number}</Text>
        {when ? <Text style={styles.when}>{when}</Text> : null}
        {enabled ? (
          <Text style={styles.progress}>{done} of {total} packed</Text>
        ) : (
          <Text style={styles.when}>{(d.checklist && d.checklist.final_message) || 'This order has no packing checklist.'}</Text>
        )}
      </View>

      {readOnlyMsg ? (
        <View style={styles.infoBanner}>
          <Ionicons name="lock-closed" size={18} color={Colors.textSecondary} />
          <Text style={styles.infoText}>{readOnlyMsg}. You can still look at the items.</Text>
        </View>
      ) : null}
      {toast ? (
        <View style={styles.errBanner}>
          <Ionicons name="alert-circle" size={18} color="#C62828" />
          <Text style={styles.errText}>{toast}</Text>
        </View>
      ) : null}

      {d.card_message ? (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Card message</Text>
          <Text style={styles.message}>{d.card_message}</Text>
        </View>
      ) : null}

      {(d.order_photos || []).length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Photos for this order</Text>
          <PhotoStrip photos={d.order_photos} />
        </View>
      ) : null}

      {d.order_voice_notes.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Voice notes for this order</Text>
          {d.order_voice_notes.map((n, i) => <VoiceNote key={i} note={n} label="Voice note" />)}
        </View>
      ) : null}

      {d.items.map((item) => {
        const isOn = !!checked[item.sale_item_id];
        const locked = !!readOnlyMsg || !enabled;
        const itemPhotos = item.photos || [];
        // Catalog photo first; a custom item with only its own photo shows that instead.
        const mainImage = item.image_url || (itemPhotos[0] && itemPhotos[0].url) || null;
        const extraPhotos = item.image_url ? itemPhotos : itemPhotos.slice(1);
        return (
          <View key={item.sale_item_id} style={[styles.card, isOn && styles.cardOn]}>
            <View style={styles.itemTop}>
              {mainImage ? (
                <TouchableOpacity onPress={() => openMedia(api.getMediaUrl(mainImage))} accessibilityRole="imagebutton" accessibilityLabel={`Open photo of ${item.name}`} activeOpacity={0.8}>
                  <Image source={{ uri: api.getMediaUrl(mainImage) }} style={styles.photo} resizeMode="cover" />
                </TouchableOpacity>
              ) : (
                <View style={[styles.photo, styles.photoEmpty]}>
                  <Ionicons name="flower-outline" size={32} color={Colors.textLight} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemQty}>x {item.quantity}</Text>
              </View>
              {enabled ? (
                <TouchableOpacity
                  style={[styles.tick, isOn && styles.tickOn, locked && { opacity: 0.6 }]}
                  onPress={() => toggle(item.sale_item_id)}
                  disabled={locked}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isOn }}
                  accessibilityLabel={`${item.name}, ${isOn ? 'packed' : 'not packed'}`}
                  activeOpacity={0.7}
                >
                  {isOn ? <Ionicons name="checkmark" size={32} color="#fff" /> : null}
                </TouchableOpacity>
              ) : null}
            </View>
            <PhotoStrip photos={extraPhotos} />
            {item.voice_notes.map((n, i) => <VoiceNote key={i} note={n} label="Voice note" />)}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2, maxWidth: 560, width: '100%', alignSelf: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xl, backgroundColor: Colors.background },
  bigMsg: { fontSize: FontSize.lg, color: Colors.text, textAlign: 'center', marginTop: Spacing.md, maxWidth: 420 },
  retryBtn: { marginTop: Spacing.lg, backgroundColor: Colors.primary, borderRadius: BorderRadius.lg, minHeight: 52, paddingHorizontal: Spacing.xl, justifyContent: 'center' },
  retryText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginBottom: Spacing.md },
  cardOn: { backgroundColor: '#E8F5E9', borderColor: Colors.success },
  kicker: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary, textTransform: 'uppercase', letterSpacing: 1 },
  orderNo: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, marginTop: 2 },
  when: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 4 },
  progress: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.success, marginTop: Spacing.sm },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginBottom: Spacing.xs },
  message: { fontSize: FontSize.md, color: Colors.text },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  photo: { width: 80, height: 80, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt },
  photoEmpty: { justifyContent: 'center', alignItems: 'center' },
  itemName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  itemQty: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 2 },
  tick: { width: 56, height: 56, borderRadius: 12, borderWidth: 3, borderColor: Colors.border, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  tickOn: { backgroundColor: Colors.success, borderColor: Colors.success },
  voiceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm, minHeight: 48 },
  voiceLabel: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  openLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.xs },
  openLinkText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600', textDecorationLine: 'underline' },
  photoStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  stripPhoto: { width: 96, height: 96, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt },
  infoBanner: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  infoText: { flex: 1, fontSize: FontSize.md, color: Colors.textSecondary },
  errBanner: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: '#FFEBEE', borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  errText: { flex: 1, fontSize: FontSize.md, color: '#C62828', fontWeight: '600' },
});
