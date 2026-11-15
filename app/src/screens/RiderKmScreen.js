/**
 * RiderKmScreen — one rider's km account (spec 2026-11-15 rider km account
 * §5, §7, §9). Opened from the rider's line on the Shopping money card.
 *
 *   Not settled yet: 112 km · ₹336
 *   ⚠ Gaps to answer                       (orange, each with three answers)
 *     12–14 Nov · Gap 314 km — answer
 *     [Add the missed readings] [Type work km] [No work]
 *   Readings                                  Add correction (owner/manager)
 *     11 Nov
 *       6:00 pm  Going home 12,470   → 34 km
 *       ...                                    (tap a reading to change it)
 *   Past settlements
 *     8 Nov · 210 km · paid ₹380 (UPI)
 *   [               Settle km               ]   (the one pink button, pinned)
 *
 * Settle km opens the settle sheet from a preview: the day lines, the money
 * lines, a "Paid to {Name}'s own UPI" switch per UPI COD order, and the
 * buttons by the sign of the total. Common case (shop pays by UPI):
 * card line → Settle km → UPI → Pay L ₹226 (UPI) = 4 taps.
 *
 * Params: { userId, name, locationId? } — or { mine: true } for the rider's
 * own read-only view (Profile → My km money → Readings): the same lists from
 * GET /rider-km/mine, with no buttons. Owner/manager also get "Usual home
 * ride" (the km a ride home normally is; empty = worked out from the rides).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet, Modal,
  KeyboardAvoidingView, Platform, RefreshControl, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { bumpActivity } from '../hooks/useIdleLock';
import { showAlert, showConfirm } from '../utils/alert';
import {
  stretchLabel, netText, clockText, dayLabel, rangeLabel, moneyText, settleDays, settleMoneyLines,
  upiCodOrders, settleChoices, moveButtonLabel, checkMoveAmount, pastSettlementText,
  trimUpiOwn, canChangeReading, withinBackDays, shopToday, usualHomeProblem,
} from '../utils/riderKm';
import KmReadingForm from '../components/expenses/KmReadingForm';
import MethodSwitch from '../components/expenses/MethodSwitch';
import { OpenRegisterForm } from '../components/OpenRegisterSheet';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const METHOD_KEY = '@petal_km_settle_method';
const METHODS = [{ key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }];
const KIND_WORDS = { arrive: 'Arriving', leave: 'Going home', typed: 'Km of work' };
const GAP_WHY = {
  missed_leave: 'Two Arriving readings in a row — a Going home reading is missing.',
  missed_arrive: 'Two Going home readings in a row — an Arriving reading is missing.',
  long_home: 'Much longer than the usual ride home.',
};
const NOTE_MS = 6000;
const BACK_DAYS_MSG = 'Counter staff can only add or change readings from the last 7 days. Ask the owner or a manager.';
const ASK_BOSS = 'Ask the owner or a manager to change it.';
const num = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
const rupeesOf = (paise) => String(Math.abs(Number(paise) || 0) / 100);
const dateFromLocal = (local) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(local || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : new Date();
};

export default function RiderKmScreen({ route, navigation }) {
  const { user, activeLocation, locked } = useAuth();
  const role = user?.role;
  // The rider's own view: read-only, from /rider-km/mine, never another rider.
  const mine = route.params?.mine === true || role === 'delivery_partner';
  const userId = mine ? Number(user?.id) : Number(route.params?.userId);
  const locationId = route.params?.locationId || activeLocation?.id || null;
  const isBoss = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';

  const [acct, setAcct] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ready | error
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const noteTimer = useRef(null);
  const alive = useRef(true);
  const name = acct?.rider?.name || route.params?.name || 'The rider';

  // Side panels.
  const [editing, setEditing] = useState(null);      // a reading
  const [typedGap, setTypedGap] = useState(null);    // a gap stretch
  const [missedGap, setMissedGap] = useState(null);  // a gap stretch
  const [correcting, setCorrecting] = useState(false);
  const [missedClose, setMissedClose] = useState(0); // bumps: the form asks before closing
  const [settleOpen, setSettleOpen] = useState(false);
  const [usualOpen, setUsualOpen] = useState(false);

  useEffect(() => { if (mine) navigation.setOptions({ title: 'My km' }); }, [mine, navigation]);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const res = mine ? await api.getMyRiderKm() : await api.getRiderKm(userId);
      if (!alive.current) return;
      setAcct(res.data || null);
      setLoadState('ready');
    } catch {
      if (alive.current) setLoadState((s) => (s === 'ready' ? 'ready' : 'error'));
    }
  }, [userId, mine]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(noteTimer.current); }; }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  // The PIN lock no longer blurs the screen: refresh on unlock.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) load();
    wasLocked.current = locked;
  }, [locked, load]);

  const showNote = (text) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), NOTE_MS);
  };
  const done = (text) => { if (text) showNote(text); load(); };

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Readings by day, newest first; each with the stretch that ends at it.
  const days = useMemo(() => {
    if (!acct) return [];
    const byTo = new Map((acct.stretches || []).map((s) => [Number(s.to_reading_id), s]));
    const groups = new Map();
    for (const r of acct.readings || []) {
      const d = String(r.read_at).slice(0, 10);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push({ reading: r, stretch: byTo.get(Number(r.id)) || null });
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, rows]) => ({ date, rows: rows.slice().reverse() }));
  }, [acct]);

  const readingById = useMemo(() => new Map(((acct && acct.readings) || []).map((r) => [Number(r.id), r])), [acct]);
  const openGaps = useMemo(() => ((acct && acct.stretches) || []).filter((s) => s.kind === 'gap' && !s.answer), [acct]);

  // Counter staff: the form opens on a day the server takes (the last 7
  // days); a gap that ended before that is for the owner or a manager.
  const openMissed = (g) => {
    if (isBoss) { setMissedGap(g); return; }
    const today = shopToday();
    if (!withinBackDays(g.end_at, today)) { showAlert('Too far back', BACK_DAYS_MSG); return; }
    setMissedGap(g);
  };
  const missedStart = (g) => {
    const from = (readingById.get(Number(g.from_reading_id)) || {}).read_at || g.end_at;
    if (isBoss || withinBackDays(from, shopToday())) return dateFromLocal(from);
    const d = dateFromLocal(shopToday());
    d.setDate(d.getDate() - 7);
    return d;
  };

  const guard = useSubmitGuard();
  const [answering, setAnswering] = useState(null);
  const noWork = guard(async (gap) => {
    setAnswering(`${gap.from_reading_id}:${gap.to_reading_id}`);
    try {
      await api.answerKmGap({ user_id: userId, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id, answer: 'none' });
      done(`Saved · no work for that ${num(gap.km)} km`);
    } catch (err) {
      showAlert('Not saved', err?.message || 'Nothing was saved. Check the connection and try again.');
      load();
    } finally {
      if (alive.current) setAnswering(null);
    }
  });

  if (!userId) {
    return <View style={styles.center}><Text style={styles.hint}>Go back and pick the rider again.</Text></View>;
  }
  if (!acct && loadState !== 'error') {
    return <View style={styles.center}><ActivityIndicator color={Colors.primary} size="large" /></View>;
  }
  if (loadState === 'error' && !acct) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>{mine ? "Couldn't load your km." : `Couldn't load ${name}'s km.`}</Text>
        <TouchableOpacity style={styles.outlineBtn} onPress={() => { setLoadState('loading'); load(); }} accessibilityRole="button">
          <Text style={styles.outlineText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const unsettled = acct.unsettled || {};
  const history = acct.history || [];
  const left = acct.rider && acct.rider.is_active === false;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.summary}>
          <Text style={styles.summaryText}>
            {`Not settled yet: ${num(unsettled.paid_km || 0)} km · ${moneyText(unsettled.amount_paise || 0)}`}
          </Text>
          {acct.open_day && (
            <Text style={styles.hint}>
              {mine
                ? 'You are at work now (no Going home reading yet). Today is settled next time.'
                : `${name} is at work now (no Going home reading yet). Today is settled next time.`}
            </Text>
          )}
          {left && !mine && <Text style={styles.hint}>{`${name} has left. Settle the last time to close the account.`}</Text>}
        </View>

        {isBoss && !mine && (
          <View style={[styles.section, styles.usualRow]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>Usual home ride</Text>
              <Text style={styles.hint}>
                {acct.usual_home_set_km != null
                  ? `${num(acct.usual_home_set_km)} km (set by hand)`
                  : acct.usual_home_km != null
                    ? `${num(acct.usual_home_km)} km (from the last rides home)`
                    : 'Not known yet. A ride home over 30 km is asked about.'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setUsualOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Change the usual home ride"
            >
              <Text style={styles.outlineText}>Change</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!note && (
          <View style={styles.note} accessibilityLiveRegion="polite">
            <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
            <Text style={styles.noteText}>{note}</Text>
          </View>
        )}

        {openGaps.length > 0 && (
          <View style={styles.section}>
            <View style={styles.gapHead}>
              <Ionicons name="warning" size={22} color={Colors.warning} />
              <Text style={styles.sectionTitle}>Gaps to answer</Text>
            </View>
            {openGaps.map((g) => {
              const from = readingById.get(Number(g.from_reading_id));
              const key = `${g.from_reading_id}:${g.to_reading_id}`;
              return (
                <View key={key} style={styles.gapCard}>
                  <Text style={styles.gapTitle}>{`${rangeLabel(from ? from.read_at : g.end_at, g.end_at)} · ${stretchLabel(g)}`}</Text>
                  {!!GAP_WHY[g.reason] && <Text style={styles.gapWhy}>{GAP_WHY[g.reason]}</Text>}
                  {mine && <Text style={styles.gapWhy}>The counter will ask you about this before settling.</Text>}
                  {!mine && <View style={styles.gapBtns}>
                    <TouchableOpacity style={styles.gapBtn} onPress={() => openMissed(g)} accessibilityRole="button">
                      <Text style={styles.gapBtnText}>Add the missed readings</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.gapBtn} onPress={() => setTypedGap(g)} accessibilityRole="button">
                      <Text style={styles.gapBtnText}>Type work km</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.gapBtn}
                      onPress={() => noWork(g)}
                      disabled={!!answering}
                      accessibilityRole="button"
                      accessibilityLabel={`No work in the ${num(g.km)} km gap`}
                    >
                      {answering === key ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.gapBtnText}>No work</Text>}
                    </TouchableOpacity>
                  </View>}
                </View>
              );
            })}
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { flex: 1 }]}>Readings</Text>
            {isBoss && !mine && (
              <TouchableOpacity style={styles.linkBtn} onPress={() => setCorrecting(true)} accessibilityRole="button">
                <Text style={styles.linkText}>Add correction</Text>
              </TouchableOpacity>
            )}
          </View>
          {days.length === 0 && (
            <Text style={styles.hint}>
              {mine ? 'No readings since the last settlement.' : 'No readings since the last settlement. Add one from Add expense → Km reading.'}
            </Text>
          )}
          {days.map((d) => (
            <View key={d.date}>
              <Text style={styles.dayHead}>{dayLabel(d.date)}</Text>
              {d.rows.map(({ reading: r, stretch: st }) => {
                const canChange = !mine && canChangeReading(r, { role, userId: user?.id, today: shopToday() });
                const body = (
                  <View style={{ flex: 1 }}>
                    <Text style={styles.readingText}>
                      {r.kind === 'typed'
                        ? `${KIND_WORDS.typed} · ${num(r.typed_km)} km`
                        : `${clockText(r.read_at)} · ${KIND_WORDS[r.kind]} · ${Number(r.meter).toLocaleString('en-IN')}`}
                    </Text>
                    {!!st && st.kind !== 'typed' && (
                      <Text style={[styles.stretchText, st.kind === 'gap' && !st.answer && styles.gapText]}>
                        {`→ ${stretchLabel(st)}`}
                      </Text>
                    )}
                    {!canChange && !mine && <Text style={styles.readOnlyHint}>{ASK_BOSS}</Text>}
                  </View>
                );
                if (!canChange) return <View key={r.id} style={styles.readingRow}>{body}</View>;
                return (
                  <TouchableOpacity
                    key={r.id}
                    style={styles.readingRow}
                    onPress={() => setEditing(r)}
                    accessibilityRole="button"
                    accessibilityLabel={`${KIND_WORDS[r.kind]} reading at ${clockText(r.read_at)}. Tap to change or remove.`}
                  >
                    {body}
                    <Ionicons name="create-outline" size={20} color={Colors.textSecondary} />
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
          {(acct.corrections || []).length > 0 && (
            <View>
              <Text style={styles.dayHead}>Corrections</Text>
              {acct.corrections.map((c) => (
                <View key={`c${c.id}`} style={styles.readingRow}>
                  <Text style={[styles.readingText, { flex: 1 }]}>{`${Number(c.km) > 0 ? '+' : ''}${num(c.km)} km · ${c.note}`}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {history.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Past settlements</Text>
            {history.map((h) => (
              <View key={`h${h.id}`} style={styles.histRow}>
                <Text style={styles.readingText}>{pastSettlementText(h)}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {!mine && (
        <View style={styles.footer}>
          {openGaps.length > 0 && <Text style={styles.footerHint}>Answer the gaps first, then settle.</Text>}
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setSettleOpen(true)} accessibilityRole="button">
            <Text style={styles.primaryText}>Settle km</Text>
          </TouchableOpacity>
        </View>
      )}
      {mine ? null : (
      <>

      <SettleSheet
        visible={settleOpen}
        userId={userId}
        name={name}
        locationId={locationId}
        isOwner={isOwner}
        navigation={navigation}
        onClose={() => setSettleOpen(false)}
        onDone={(text) => { setSettleOpen(false); done(text); }}
      />

      <SheetModal visible={!!missedGap} onClose={() => setMissedClose((n) => n + 1)}>
        {!!missedGap && (
          <KmReadingForm
            locationId={locationId}
            presetRider={{ id: userId, name }}
            startOn={missedStart(missedGap)}
            closeRequest={missedClose}
            onClose={() => setMissedGap(null)}
            onDone={(r) => { setMissedGap(null); done(r && r.message); }}
          />
        )}
      </SheetModal>

      <TypedGapSheet gap={typedGap} userId={userId} onClose={() => setTypedGap(null)} onDone={(t) => { setTypedGap(null); done(t); }} />
      <EditReadingSheet reading={editing} onClose={() => setEditing(null)} onDone={(t) => { setEditing(null); done(t); }} />
      <CorrectionSheet visible={correcting} userId={userId} name={name} onClose={() => setCorrecting(false)} onDone={(t) => { setCorrecting(false); done(t); }} />
      {isBoss && (
        <UsualHomeSheet
          visible={usualOpen}
          userId={userId}
          name={name}
          current={acct.usual_home_set_km}
          onClose={() => setUsualOpen(false)}
          onDone={(t) => { setUsualOpen(false); done(t); }}
        />
      )}
      </>
      )}
    </View>
  );
}

// A bottom sheet with idle-lock activity wired on its content.
function SheetModal({ visible, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>{children}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SheetHeader({ title, onClose }) {
  return (
    <View style={styles.sheetHead}>
      <Text style={styles.sheetTitle}>{title}</Text>
      <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
        <Ionicons name="close" size={26} color={Colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Settle sheet ────────────────────────────────────────────
function SettleSheet({ visible, userId, name, locationId, isOwner, navigation, onClose, onDone }) {
  const [pv, setPv] = useState(null);
  const [pvState, setPvState] = useState('loading'); // loading | ready | blocked | error
  const [blockedMsg, setBlockedMsg] = useState('');
  const [upiOwn, setUpiOwn] = useState([]);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [takeOpen, setTakeOpen] = useState(false);
  const [needRegister, setNeedRegister] = useState(null); // { message, action }
  const [saving, setSaving] = useState(null); // the action being saved
  const [pvBusy, setPvBusy] = useState(false); // figures being worked out again
  const req = useRef(0);

  const preview = async (own) => {
    const n = ++req.current;
    setPvState((s) => (s === 'ready' ? 'ready' : 'loading'));
    setPvBusy(true);
    try {
      const res = await api.settleKm(userId, { location_id: locationId, preview: true, upi_own_delivery_ids: own });
      if (n !== req.current) return;
      setPvBusy(false);
      setPv(res.data);
      setUpiOwn(trimUpiOwn(own, res.data && res.data.lines));
      setAmount(rupeesOf(res.data.net_paise));
      setPvState('ready');
    } catch (err) {
      if (n !== req.current) return;
      setPvBusy(false);
      if (err && (err.code === 'GAPS_OPEN' || err.code === 'NOTHING')) {
        setBlockedMsg(err.message);
        setPvState('blocked');
        return;
      }
      setBlockedMsg(err?.message || 'Could not load the figures. Check the connection and try again.');
      setPvState('error');
    }
  };

  useEffect(() => {
    if (!visible) return;
    setPv(null); setUpiOwn([]); setTakeOpen(false); setNeedRegister(null); setSaving(null); setPvState('loading');
    (async () => {
      try { const m = await AsyncStorage.getItem(METHOD_KEY); if (m === 'cash' || m === 'upi') setMethod(m); } catch { /* default */ }
    })();
    if (!locationId) {
      setBlockedMsg('This device has no shop picked. Pick your shop on the dashboard, then try again.');
      setPvState('error');
      return;
    }
    preview([]);
  }, [visible]);

  const toggleOwn = (id) => {
    const next = upiOwn.includes(id) ? upiOwn.filter((x) => x !== id) : [...upiOwn, id];
    setUpiOwn(next);
    preview(next);
  };
  const pickMethod = (m) => {
    setMethod(m);
    AsyncStorage.setItem(METHOD_KEY, m).catch(() => {});
  };

  const guard = useSubmitGuard();
  const commit = guard(async (action, extra = {}) => {
    if (!pv) return;
    setSaving(action);
    const body = {
      location_id: locationId, action, expected_net_paise: pv.net_paise, last_settlement_id: pv.last_settlement_id,
      upi_own_delivery_ids: upiOwn, ...extra,
    };
    try {
      const res = await api.settleKm(userId, body);
      const d = res.data || {};
      setSaving(null);
      onDone(successText(d, name));
    } catch (err) {
      setSaving(null);
      const code = err && err.code;
      if (code === 'REGISTER_CLOSED') { setNeedRegister({ message: err.message, action, extra }); return; }
      if (code === 'CHANGED') {
        showAlert('Figures changed', err.message);
        preview(upiOwn);
        return;
      }
      if (code === 'GAPS_OPEN' || code === 'NOTHING') {
        showAlert('Not settled', err.message);
        onDone('');
        return;
      }
      showAlert('Not settled', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  });

  const net = pv ? Number(pv.net_paise) : 0;
  const choices = settleChoices(net, name, { owner: isOwner });
  const moveAction = net > 0 ? 'pay' : 'take';
  const showMove = net > 0 || (net < 0 && takeOpen);
  const amountError = showMove ? checkMoveAmount(amount, net) : null;
  const leftOver = showMove && !amountError ? Math.abs(net) - Math.round(Number(amount) * 100) : 0;
  const busy = !!saving || pvBusy;
  const lines = pv ? pv.lines : null;

  const moveBtn = (
    <TouchableOpacity
      style={[styles.primaryBtn, (!!amountError || busy) && styles.btnOff]}
      onPress={() => commit(moveAction, { amount: String(amount).trim(), method })}
      disabled={!!amountError || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!amountError || busy }}
    >
      {saving === moveAction ? <ActivityIndicator color={Colors.white} />
        : <Text style={styles.primaryText}>{amountError ? 'Fix the amount above' : moveButtonLabel(moveAction, name, String(amount).trim(), method)}</Text>}
    </TouchableOpacity>
  );
  const moveBlock = (
    <View style={{ gap: Spacing.sm }}>
      <MethodSwitch value={method} options={METHODS} onChange={pickMethod} />
      <Text style={styles.label}>Amount (₹)</Text>
      <TextInput
        style={[styles.input, !!amountError && styles.inputError]}
        value={amount}
        onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
        keyboardType="decimal-pad"
        accessibilityLabel={net > 0 ? `Amount to pay ${name}` : `Amount to take from ${name}`}
      />
      {!!amountError && <Text style={styles.error}>{amountError}</Text>}
      {leftOver > 0 && <Text style={styles.hint}>{`${moneyText(leftOver)} is carried to next time.`}</Text>}
      {moveBtn}
    </View>
  );
  const secondary = (label, onPress, action) => (
    <TouchableOpacity style={[styles.outlineBtn, busy && styles.btnOff]} onPress={onPress} disabled={busy} accessibilityRole="button">
      {saving === action ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.outlineText}>{label}</Text>}
    </TouchableOpacity>
  );

  return (
    <SheetModal visible={visible} onClose={onClose}>
      {needRegister ? (
        <View>
          <Text style={styles.registerMsg}>{needRegister.message}</Text>
          <OpenRegisterForm
            locationId={locationId}
            actionLabel={needRegister.action === 'pay' ? `pay ₹${String(amount).trim()}` : `take ₹${String(amount).trim()}`}
            onClose={onClose}
            onOpened={() => { const n = needRegister; setNeedRegister(null); commit(n.action, n.extra); }}
            onBack={() => { pickMethod('upi'); setNeedRegister(null); }}
            backLabel="Pick UPI instead"
          />
        </View>
      ) : (
        <>
          <SheetHeader title={`Settle ${name}'s km`} onClose={onClose} />
          {pvState === 'loading' && <ActivityIndicator color={Colors.primary} style={{ marginVertical: Spacing.xl }} />}
          {(pvState === 'blocked' || pvState === 'error') && (
            <View style={{ gap: Spacing.md, paddingVertical: Spacing.md }}>
              <Text style={styles.blocked}>{blockedMsg}</Text>
              {pvState === 'error' && secondary('Try again', () => preview(upiOwn), 'retry')}
              {secondary('Close', onClose, 'close')}
            </View>
          )}
          {pvState === 'ready' && !!lines && (
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              {settleDays(lines).map((d) => (
                <View key={d.date} style={styles.line}>
                  <Text style={styles.lineLabel}>{d.label}</Text>
                  <Text style={styles.lineValue}>{d.text}</Text>
                </View>
              ))}
              {(lines.corrections || []).map((c) => (
                <View key={`c${c.id}`} style={styles.line}>
                  <Text style={styles.lineLabel} numberOfLines={2}>{`Correction · ${c.note}`}</Text>
                  <Text style={styles.lineValue}>{`${Number(c.km) > 0 ? '+' : ''}${num(c.km)} km`}</Text>
                </View>
              ))}
              <View style={styles.rule} />
              {settleMoneyLines(lines, name).map((l) => (
                <View key={l.key}>
                  <View style={styles.line}>
                    <Text style={styles.lineLabel}>{l.label}</Text>
                    <Text style={styles.lineValue}>{moneyText(l.paise, true)}</Text>
                  </View>
                  {l.key === 'supply' && (lines.shopping || []).map((m) => (
                    <TouchableOpacity
                      key={`s${m.id}`}
                      style={styles.linkBtn}
                      onPress={() => { onClose(); navigation.navigate('ShoppingMoneyBack', { id: m.id, locationId }); }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.linkText}>{`${name} is back — what was bought? (${moneyText(m.remaining_paise)}) ›`}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
              {upiCodOrders(lines).map((d) => {
                const on = upiOwn.includes(d.delivery_id);
                return (
                  <TouchableOpacity
                    key={`u${d.delivery_id}`}
                    style={styles.switchRow}
                    onPress={() => toggleOwn(d.delivery_id)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: on }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.lineLabel}>{`${d.sale_number || `Order ${d.delivery_id}`} · UPI ${moneyText(d.upi_paise)}`}</Text>
                      <Text style={styles.hint}>{`Paid to ${name}'s own UPI`}</Text>
                    </View>
                    <Switch value={on} onValueChange={() => toggleOwn(d.delivery_id)} />
                  </TouchableOpacity>
                );
              })}
              <View style={styles.rule} />
              <Text style={styles.total}>{netText(name, net)}</Text>

              <View style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
                {net > 0 && moveBlock}
                {net < 0 && !takeOpen && (
                  <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnOff]} onPress={() => commit('carry')} disabled={busy} accessibilityRole="button">
                    {saving === 'carry' ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>{choices.primary.label}</Text>}
                  </TouchableOpacity>
                )}
                {net < 0 && takeOpen && moveBlock}
                {net === 0 && (
                  <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnOff]} onPress={() => commit('zero')} disabled={busy} accessibilityRole="button">
                    {saving === 'zero' ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Settle</Text>}
                  </TouchableOpacity>
                )}
                {!!choices.carry && secondary(choices.carry, () => commit('carry'), 'carry')}
                {net < 0 && takeOpen && secondary(`Carry ${moneyText(net)} to next time`, () => commit('carry'), 'carry')}
                {net < 0 && !takeOpen && secondary(choices.take, () => { setTakeOpen(true); setAmount(rupeesOf(net)); }, 'take-open')}
                {!!choices.salary && secondary(choices.salary, () => showConfirm(
                  'Take from salary',
                  `${netText(name, net)} goes to the next payroll for ${name}.`,
                  () => commit('salary'),
                  { confirmLabel: 'Yes, to payroll', cancelLabel: 'Back' },
                ), 'salary')}
              </View>
            </ScrollView>
          )}
        </>
      )}
    </SheetModal>
  );
}

function successText(d, name) {
  const moved = moneyText(d.moved_paise || 0);
  const m = d.moved_method === 'upi' ? 'UPI' : 'cash';
  const carry = Number(d.carry_out_paise) || 0;
  const after = carry ? ` · ${netText(name, carry)} next time` : '';
  if (d.for_salary) return `Settled · ${netText(name, carry)} at the next payroll`;
  if (d.action === 'pay') return `Paid ${name} ${moved} by ${m}${after}`;
  if (d.action === 'take') return `Took ${moved} from ${name} by ${m}${after}`;
  if (d.action === 'carry') return `Settled${after}`;
  return 'Settled';
}

// ─── Type work km for a gap ──────────────────────────────────
function TypedGapSheet({ gap, userId, onClose, onDone }) {
  const [km, setKm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (gap) { setKm(''); setError(''); setSaving(false); } }, [gap]);
  const guard = useSubmitGuard();
  const save = guard(async () => {
    const t = km.trim();
    const n = Number(t);
    if (!/^\d+(\.\d)?$/.test(t) || n > Number(gap.km)) { setError(`Type a number from 0 to ${num(gap.km)}.`); return; }
    setSaving(true);
    try {
      await api.answerKmGap({ user_id: userId, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id, answer: 'typed', work_km: t });
      setSaving(false);
      onDone(`Saved · ${num(n)} km of work in that gap`);
    } catch (err) {
      setSaving(false);
      showAlert('Not saved', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  });
  return (
    <SheetModal visible={!!gap} onClose={onClose}>
      {!!gap && (
        <View style={{ gap: Spacing.sm }}>
          <SheetHeader title="Type work km" onClose={onClose} />
          <Text style={styles.hint}>{`How many of the ${num(gap.km)} km were work?`}</Text>
          <View style={[styles.inputRow, !!error && styles.inputError]}>
            <TextInput
              style={styles.inputBig}
              value={km}
              onChangeText={(t) => { setKm(t.replace(/[^0-9.]/g, '')); setError(''); }}
              keyboardType="decimal-pad"
              autoFocus
              placeholder="0"
              placeholderTextColor={Colors.textLight}
              accessibilityLabel="Km of work"
            />
            <Text style={styles.unit}>km</Text>
          </View>
          {!!error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity style={[styles.primaryBtn, saving && styles.btnOff]} onPress={save} disabled={saving} accessibilityRole="button">
            {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Save</Text>}
          </TouchableOpacity>
        </View>
      )}
    </SheetModal>
  );
}

// ─── Change or remove an unsettled reading ───────────────────
function EditReadingSheet({ reading, onClose, onDone }) {
  const typed = reading && reading.kind === 'typed';
  const [kind, setKind] = useState('arrive');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null); // 'save' | 'remove'
  useEffect(() => {
    if (!reading) return;
    setKind(reading.kind);
    setValue(String(reading.kind === 'typed' ? reading.typed_km : reading.meter));
    setError('');
    setSaving(null);
  }, [reading]);

  const guard = useSubmitGuard();
  const send = async (confirmBig) => {
    setSaving('save');
    try {
      const body = typed ? { typed_km: value.trim() } : { kind, meter: value.trim() };
      if (confirmBig) body.confirm_big = true;
      await api.changeKmReading(reading.id, body);
      setSaving(null);
      onDone('Reading changed');
    } catch (err) {
      setSaving(null);
      if (err && err.code === 'CONFIRM_BIG') {
        showConfirm('Check the meter', err.raw_message || err.message, guard(() => send(true)),
          { confirmLabel: 'Yes, save it', cancelLabel: 'No, fix it' });
        return;
      }
      showAlert('Not changed', err?.message || 'Nothing was changed. Check the connection and try again.');
    }
  };
  const save = guard(async () => {
    const t = value.trim();
    if (typed ? !/^\d+(\.\d)?$/.test(t) || Number(t) <= 0 : !/^\d+(\.\d+)?$/.test(t)) {
      setError(typed ? 'Type the km of work, like 24.' : 'Type the number shown on the bike meter, like 12345.');
      return;
    }
    await send(false);
  });
  const remove = guard(async () => {
    setSaving('remove');
    try {
      await api.removeKmReading(reading.id);
      setSaving(null);
      onDone('Reading removed');
    } catch (err) {
      setSaving(null);
      showAlert('Not removed', err?.message || 'Nothing was removed. Check the connection and try again.');
    }
  });

  return (
    <SheetModal visible={!!reading} onClose={onClose}>
      {!!reading && (
        <View style={{ gap: Spacing.sm }}>
          <SheetHeader title={`${dayLabel(reading.read_at)}${typed ? '' : ` · ${clockText(reading.read_at)}`}`} onClose={onClose} />
          {!typed && (
            <View style={styles.kindRow} accessibilityRole="radiogroup">
              {['arrive', 'leave'].map((k) => (
                <TouchableOpacity
                  key={k}
                  style={[styles.kindBtn, kind === k && styles.kindBtnOn]}
                  onPress={() => setKind(k)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: kind === k }}
                >
                  <Text style={[styles.kindText, kind === k && styles.kindTextOn]}>{KIND_WORDS[k]}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <Text style={styles.label}>{typed ? 'Km of work' : 'Meter'}</Text>
          <TextInput
            style={[styles.input, !!error && styles.inputError]}
            value={value}
            onChangeText={(t) => { setValue(t.replace(/[^0-9.]/g, '')); setError(''); }}
            keyboardType="decimal-pad"
            accessibilityLabel={typed ? 'Km of work' : 'Meter reading'}
          />
          {!!error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity style={[styles.primaryBtn, !!saving && styles.btnOff]} onPress={save} disabled={!!saving} accessibilityRole="button">
            {saving === 'save' ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Save changes</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.dangerBtn}
            disabled={!!saving}
            onPress={() => showConfirm('Remove this reading?', 'The km around it will be worked out again.', remove,
              { confirmLabel: 'Remove', cancelLabel: 'Keep it', destructive: true })}
            accessibilityRole="button"
          >
            {saving === 'remove' ? <ActivityIndicator color={Colors.error} /> : <Text style={styles.dangerText}>Remove reading</Text>}
          </TouchableOpacity>
        </View>
      )}
    </SheetModal>
  );
}

// ─── Correction (owner / manager) ────────────────────────────
function CorrectionSheet({ visible, userId, name, onClose, onDone }) {
  const [km, setKm] = useState('');
  const [noteText, setNoteText] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (visible) { setKm(''); setNoteText(''); setErrors({}); setSaving(false); } }, [visible]);
  const guard = useSubmitGuard();
  const save = guard(async () => {
    const e = {};
    const t = km.trim();
    if (!/^-?\d+(\.\d)?$/.test(t) || Number(t) === 0) e.km = 'Type the km to add or take off, like 12 or -5.';
    if (!noteText.trim()) e.note = 'Type why, so it is clear later.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      await api.addKmCorrection({ user_id: userId, km: t, note: noteText.trim() });
      setSaving(false);
      onDone(`Correction saved · ${Number(t) > 0 ? '+' : ''}${num(t)} km in the next settlement`);
    } catch (err) {
      setSaving(false);
      showAlert('Not saved', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  });
  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={{ gap: Spacing.sm }}>
        <SheetHeader title={`Correction for ${name}`} onClose={onClose} />
        <Text style={styles.hint}>It is added to the next settlement. Use a minus to take km off, like -5.</Text>
        <Text style={styles.label}>Km</Text>
        <TextInput
          style={[styles.input, !!errors.km && styles.inputError]}
          value={km}
          onChangeText={(t) => { setKm(t.replace(/[^0-9.-]/g, '')); setErrors((x) => ({ ...x, km: undefined })); }}
          keyboardType="numbers-and-punctuation"
          accessibilityLabel="Km to add or take off"
        />
        {!!errors.km && <Text style={styles.error}>{errors.km}</Text>}
        <Text style={styles.label}>Why?</Text>
        <TextInput
          style={[styles.input, !!errors.note && styles.inputError]}
          value={noteText}
          onChangeText={(t) => { setNoteText(t); setErrors((x) => ({ ...x, note: undefined })); }}
          placeholder="Like: meter read wrong on 10 Nov"
          placeholderTextColor={Colors.textLight}
          accessibilityLabel="Why"
        />
        {!!errors.note && <Text style={styles.error}>{errors.note}</Text>}
        <TouchableOpacity style={[styles.primaryBtn, saving && styles.btnOff]} onPress={save} disabled={saving} accessibilityRole="button">
          {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Save correction</Text>}
        </TouchableOpacity>
      </View>
    </SheetModal>
  );
}

// ─── Usual home ride (owner / manager) ───────────────────────
function UsualHomeSheet({ visible, userId, name, current, onClose, onDone }) {
  const [km, setKm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null); // 'save' | 'clear'
  useEffect(() => {
    if (visible) { setKm(current != null ? String(current) : ''); setError(''); setSaving(null); }
  }, [visible]);
  const guard = useSubmitGuard();
  const send = async (value, which) => {
    setSaving(which);
    try {
      await api.setKmUsualHome(userId, value);
      setSaving(null);
      onDone(value == null ? 'Saved · worked out from the rides home' : `Saved · usual home ride ${num(value)} km`);
    } catch (err) {
      setSaving(null);
      showAlert('Not saved', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  };
  const save = guard(async () => {
    const t = km.trim();
    const problem = usualHomeProblem(t);
    if (problem) { setError(problem); return; }
    await send(t === '' ? null : t, 'save');
  });
  const clear = guard(async () => { await send(null, 'clear'); });
  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={{ gap: Spacing.sm }}>
        <SheetHeader title="Usual home ride" onClose={onClose} />
        <Text style={styles.hint}>
          {`How far ${name}'s ride home normally is. A ride home over twice this is asked about before settling. Leave it empty to work it out from the last rides home.`}
        </Text>
        <View style={[styles.inputRow, !!error && styles.inputError]}>
          <TextInput
            style={styles.inputBig}
            value={km}
            onChangeText={(t) => { setKm(t.replace(/[^0-9.]/g, '')); setError(''); }}
            keyboardType="decimal-pad"
            autoFocus
            placeholder="Empty"
            placeholderTextColor={Colors.textLight}
            accessibilityLabel="Usual home ride in km"
          />
          <Text style={styles.unit}>km</Text>
        </View>
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity style={[styles.primaryBtn, !!saving && styles.btnOff]} onPress={save} disabled={!!saving} accessibilityRole="button">
          {saving === 'save' ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Save</Text>}
        </TouchableOpacity>
        {current != null && (
          <TouchableOpacity style={[styles.outlineBtn, !!saving && styles.btnOff]} onPress={clear} disabled={!!saving} accessibilityRole="button">
            {saving === 'clear' ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.outlineText}>Work it out from the rides</Text>}
          </TouchableOpacity>
        )}
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md, backgroundColor: Colors.background },
  scroll: { padding: Spacing.md, paddingBottom: Spacing.xl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  summary: { marginBottom: Spacing.sm, gap: Spacing.xs },
  summaryText: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  hint: { fontSize: FontSize.md, color: Colors.textSecondary },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, marginBottom: Spacing.sm, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.sm,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  gapHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 40 },
  gapCard: {
    borderWidth: 2, borderColor: Colors.warning, backgroundColor: Colors.warningLight, borderRadius: BorderRadius.md,
    padding: Spacing.sm, marginTop: Spacing.sm, gap: Spacing.xs,
  },
  gapTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  gapWhy: { fontSize: FontSize.md, color: Colors.text },
  gapBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.xs },
  gapBtn: {
    minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center',
  },
  gapBtnText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  gapText: { color: Colors.warning, fontWeight: '700' },
  dayHead: { fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary, marginTop: Spacing.sm },
  readingRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52,
    borderTopWidth: 1, borderTopColor: Colors.border, paddingVertical: Spacing.xs,
  },
  readingText: { fontSize: FontSize.md, color: Colors.text, fontVariant: ['tabular-nums'] },
  stretchText: { fontSize: FontSize.md, color: Colors.textSecondary },
  readOnlyHint: { fontSize: FontSize.md, color: Colors.textSecondary },
  histRow: { minHeight: 44, justifyContent: 'center', borderTopWidth: 1, borderTopColor: Colors.border },
  linkBtn: { minHeight: 48, justifyContent: 'center' },
  usualRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  smallBtn: {
    minHeight: 48, minWidth: 88, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md,
  },
  linkText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  footer: {
    padding: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, backgroundColor: Colors.surface, gap: Spacing.xs,
  },
  footerHint: { fontSize: FontSize.md, color: Colors.text, textAlign: 'center' },
  primaryBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md, width: '100%', maxWidth: 800, alignSelf: 'center',
  },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800', textAlign: 'center' },
  outlineBtn: {
    minHeight: 52, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md,
  },
  outlineText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700', textAlign: 'center' },
  dangerBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  dangerText: { color: Colors.error, fontSize: FontSize.md, fontWeight: '700' },
  btnOff: { opacity: 0.5 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '92%',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center' },
  sheetTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  sheetScroll: { flexGrow: 0 },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 36, gap: Spacing.sm },
  lineLabel: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  lineValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  rule: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56 },
  total: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  blocked: { fontSize: FontSize.md, color: Colors.text },
  registerMsg: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, backgroundColor: Colors.background,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, backgroundColor: Colors.background,
  },
  inputBig: { flex: 1, minHeight: 54, fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  unit: { fontSize: FontSize.lg, color: Colors.textSecondary, marginLeft: Spacing.xs },
  inputError: { borderColor: Colors.error },
  error: { color: Colors.error, fontSize: FontSize.md },
  kindRow: { flexDirection: 'row', gap: Spacing.sm },
  kindBtn: {
    flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  kindBtnOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  kindText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  kindTextOn: { color: Colors.white, fontWeight: '800' },
});
