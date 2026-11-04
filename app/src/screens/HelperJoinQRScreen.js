import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image, ActivityIndicator, Linking, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../utils/alert';
import { waLink } from '../utils/contact';
import { formatShopDateTime } from '../utils/helperAccess';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

// Shows a helper's one-time join QR (spec §8.3). Opening this screen makes a
// fresh code (the server keeps only a hash, so an old code can't be shown
// again); making a new one cancels the old one.
export default function HelperJoinQRScreen({ route, navigation }) {
  const helper = route.params?.helper || {};
  const { settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const firstName = String(helper.name || '').trim().split(/\s+/)[0] || 'the helper';

  const [link, setLink] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const guardSubmit = useSubmitGuard();

  const makeCode = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createHelperJoinLink(helper.id);
      setLink(res.data || null);
    } catch (err) {
      setError(err?.message || "Couldn't make the code. Check the internet and tap Try again.");
    } finally {
      setLoading(false);
    }
  }, [helper.id]);

  useEffect(() => { makeCode(); }, [makeCode]);

  const expiry = link?.expires_at ? formatShopDateTime(link.expires_at, timezone) : '';

  const shareOnWhatsApp = () => {
    if (!link?.url) return;
    if (!helper.phone) {
      showAlert('No phone number', "This helper has no phone number saved. Show them the code on this screen instead.");
      return;
    }
    const msg = `Hi ${firstName}, open this link on your phone to set up the shop app and pick your 4-digit PIN:\n${link.url}\nIt works once${expiry ? `, until ${expiry}` : ''}.`;
    Linking.openURL(waLink(helper.phone, msg)).catch(() => {
      showAlert("Couldn't open WhatsApp", 'Show them the code on this screen instead.');
    });
  };

  const askNewCode = () => {
    showConfirm(
      'Make a new code?',
      'The old code will stop working.',
      guardSubmit(makeCode),
      { confirmLabel: 'Make new code' },
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Join code for {helper.name || 'the helper'}</Text>

      {loading ? (
        <View style={styles.qrBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle-outline" size={28} color={Colors.error} />
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Try again" variant="outline" onPress={guardSubmit(makeCode)} style={styles.retry} />
        </View>
      ) : (
        <>
          <View style={styles.qrBox}>
            {link?.qr_data_url ? (
              <Image
                source={{ uri: link.qr_data_url }}
                style={styles.qr}
                resizeMode="contain"
                accessibilityLabel={`Join code for ${helper.name || 'the helper'}`}
              />
            ) : null}
          </View>
          {!!expiry && <Text style={styles.expiry}>This code works until {expiry}, once.</Text>}

          <View style={styles.steps}>
            <Text style={styles.step}>1. Ask {firstName} to open their phone camera.</Text>
            <Text style={styles.step}>2. Point it at this code.</Text>
            <Text style={styles.step}>3. They set a 4-digit PIN. Done.</Text>
          </View>

          <Button
            title="Share on WhatsApp"
            size="lg"
            icon={<Ionicons name="logo-whatsapp" size={22} color={Colors.white} />}
            onPress={shareOnWhatsApp}
            style={styles.primary}
          />
          <Text style={styles.shareHint}>Not with them? Send the link and they open it on their phone.</Text>

          <TouchableOpacity
            style={styles.secondary}
            onPress={askNewCode}
            accessibilityRole="button"
          >
            <Ionicons name="refresh" size={20} color={Colors.primary} />
            <Text style={styles.secondaryText}>Make a new code</Text>
          </TouchableOpacity>
        </>
      )}

      <Button title="Done" variant="ghost" onPress={() => navigation.goBack()} style={styles.done} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.lg, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 520, alignSelf: 'center', alignItems: 'stretch' },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.md },
  qrBox: {
    alignSelf: 'center', width: 300, maxWidth: '100%', aspectRatio: 1,
    backgroundColor: Colors.white, borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, justifyContent: 'center', alignItems: 'center',
  },
  qr: { width: '100%', height: '100%' },
  expiry: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.md },
  steps: {
    marginTop: Spacing.lg, padding: Spacing.md, gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
  },
  step: { fontSize: FontSize.lg, color: Colors.text, lineHeight: 28 },
  primary: { marginTop: Spacing.lg, gap: Spacing.sm },
  shareHint: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  secondary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 48, marginTop: Spacing.lg,
  },
  secondaryText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  errorBox: {
    alignItems: 'center', gap: Spacing.sm, padding: Spacing.lg,
    backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md,
  },
  errorText: { fontSize: FontSize.md, color: Colors.text, textAlign: 'center' },
  retry: { marginTop: Spacing.sm, alignSelf: 'stretch' },
  done: { marginTop: Spacing.md },
});
