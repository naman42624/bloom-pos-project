// The app's only screen a visitor can reach with no login and no session —
// see App.js for the routing bypass that renders this directly, before
// AuthProvider/RootNavigator ever mount. Because of that, this file must
// import NOTHING that depends on AuthContext or React Navigation. Colors/
// Spacing (theme.js) and the plain date-formatting helpers (datetime.js)
// have no such dependency and are safe.
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import api from '../services/api';
import { getTrackingSteps } from '../utils/trackingSteps';
// formatShopDateLabel for the date ("Today"/"Tomorrow"/formatted date) +
// formatTimeString for the time — NOT formatTime on a concatenated
// `${date}T${time}` string. scheduled_date/scheduled_time are shop-local
// wall-clock values, not UTC; formatTime's underlying parseServerDate
// treats an unmarked 'T'-containing string as UTC and appends 'Z', which
// would then get shop-timezone-converted a SECOND time, double-shifting
// the displayed hour. formatTimeString parses "HH:MM:SS" as plain digits
// with no Date object involved at all — no timezone conversion, no bug
// surface. (Caught in this plan's own self-review, 2026-09-11 — do not
// "simplify" this back to formatTime on a joined string.)
import { formatShopDateLabel, formatTimeString } from '../utils/datetime';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

export default function TrackingScreen({ token }) {
  const [state, setState] = useState({ loading: true, data: null, notFound: false });

  useEffect(() => {
    let cancelled = false;
    api.getTrackingInfo(token)
      .then((res) => { if (!cancelled) setState({ loading: false, data: res.data, notFound: false }); })
      .catch(() => { if (!cancelled) setState({ loading: false, data: null, notFound: true }); });
    return () => { cancelled = true; };
  }, [token]);

  if (state.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (state.notFound || !state.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFoundTitle}>We couldn't find this order</Text>
        <Text style={styles.notFoundText}>The link may be out of date — please contact the shop.</Text>
      </View>
    );
  }

  const { sale_number, order_type, stage_label, scheduled_date, scheduled_time, location_name } = state.data;
  // The tracking API returns a LABEL (e.g. "Ready for Pickup"), but
  // getTrackingSteps needs the underlying stage KEY. Labels aren't 1:1 with
  // keys across order types (e.g. "Ready" is a real key for both delivery
  // and the walk_in/pre_order default ladder), so build the reverse lookup
  // from the same label text this screen actually received rather than
  // re-deriving stage logic here — a tiny local map covers every label
  // server/utils/order-stage.js can produce (see Task 1's own comment for
  // the authoritative list).
  const LABEL_TO_KEY = {
    'New': 'new', 'Preparing': 'preparing', 'Ready for Pickup': 'ready_for_pickup',
    'Picked Up': 'picked_up', 'Ready': 'ready', 'Out for Delivery': 'out_for_delivery',
    'Delivered': 'delivered', 'Completed': 'completed', 'Cancelled': 'cancelled',
  };
  const stageKey = LABEL_TO_KEY[stage_label] || 'new';
  const tracking = getTrackingSteps(order_type, stageKey);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.saleNumber}>{sale_number}</Text>
        {location_name && <Text style={styles.location}>{location_name}</Text>}

        {tracking ? (
          <View style={styles.stepsRow}>
            {tracking.steps.map((step, i) => (
              <React.Fragment key={step.label}>
                <View style={styles.stepItem}>
                  <View style={[
                    styles.stepDot,
                    step.done && styles.stepDotDone,
                    step.current && styles.stepDotCurrent,
                  ]} />
                  <Text style={[styles.stepLabel, step.current && styles.stepLabelCurrent]}>{step.label}</Text>
                </View>
                {i < tracking.steps.length - 1 && <View style={[styles.stepLine, step.done && styles.stepLineDone]} />}
              </React.Fragment>
            ))}
          </View>
        ) : (
          <View style={styles.cancelledBox}>
            <Text style={styles.cancelledText}>This order was cancelled.</Text>
          </View>
        )}

        {scheduled_date && (
          <Text style={styles.scheduled}>
            {order_type === 'delivery' ? 'Scheduled delivery: ' : 'Scheduled: '}
            {formatShopDateLabel(scheduled_date)}
            {scheduled_time ? `, ${formatTimeString(scheduled_time)}` : ''}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: Colors.background, minHeight: '100%' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 420 },
  saleNumber: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  location: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', marginTop: 4, marginBottom: Spacing.lg },
  notFoundTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  notFoundText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  stepsRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: Spacing.lg, flexWrap: 'wrap' },
  stepItem: { alignItems: 'center', width: 72 },
  stepDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: Colors.border },
  stepDotDone: { backgroundColor: Colors.success },
  stepDotCurrent: { backgroundColor: Colors.primary, width: 20, height: 20, borderRadius: 10 },
  stepLabel: { fontSize: FontSize.xs, color: Colors.textLight, textAlign: 'center', marginTop: 6 },
  stepLabelCurrent: { color: Colors.primary, fontWeight: '700' },
  stepLine: { flex: 1, height: 2, backgroundColor: Colors.border, marginTop: 8, minWidth: 12 },
  stepLineDone: { backgroundColor: Colors.success },
  cancelledBox: { backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.lg },
  cancelledText: { color: Colors.error, fontWeight: '600', textAlign: 'center' },
  scheduled: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.lg },
});
