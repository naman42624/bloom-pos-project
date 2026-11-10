import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius, Shadows, TouchTarget } from '../constants/theme';
import { isRegisterStale } from '../hooks/useRegisterStatus';
import { formatDateLabel } from '../utils/datetime';
import { showAlert, showConfirm, appAlert } from '../utils/alert';
import { buildQuickSalePayload, amountError, TOPUP_LABEL } from '../utils/quickSale';
import { METHOD_COLOR } from '../components/quickSale/QuickSaleRoll';
import useSubmitGuard from '../hooks/useSubmitGuard';
import ReceiveCashSheet from '../components/helperCash/ReceiveCashSheet';
import { closeWarningLines, handoverDoneText } from '../utils/helperCash';
import { lastCloseFromStatus, lastCloseCashText, lastCloseHint } from '../utils/lastClose';

const formatTime = (timeStr) => {
  if (!timeStr) return '-';
  const d = new Date(timeStr);
  if (isNaN(d.getTime())) return timeStr;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatDate = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

const HistoryCard = ({ session, isToday }) => {
  const [expanded, setExpanded] = useState(false);

  const opening = Number(session.opening_balance || 0);
  const cashSales = Number(session.total_cash_sales || 0);
  const cashRefunds = Number(session.total_refunds_cash || 0);
  const expected = Number(session.expected_cash || 0);
  const actual = Number(session.actual_cash || 0);
  const discrepancy = Number(session.discrepancy || 0);
  // Helper cash bags: change handed to helpers left the drawer, cash
  // received from helpers came into it. Neither is an expense.
  const helperFloats = Number(session.helper_floats || 0);
  const helperHandovers = Number(session.helper_handovers || 0);
  
  // Dynamically derive Net Cash Expenses for closed sessions
  // expected = opening + cashSales - cashRefunds - floats + handovers - netExpenses
  // netExpenses = opening + cashSales - cashRefunds - floats + handovers - expected
  const inferredExpenses = Math.round((opening + cashSales - cashRefunds - helperFloats + helperHandovers - expected) * 100) / 100;
  const hasDiscrepancy = Math.abs(discrepancy) >= 1;

  return (
    <View style={styles.histCard}>
      <TouchableOpacity 
        style={styles.histHeaderBtn} 
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
            <Text style={styles.histDate}>{isToday ? `Session (Today)` : formatDate(session.date)}</Text>
            <View style={[styles.statusBadge, { backgroundColor: session.closed_at ? Colors.surfaceAlt : Colors.successLight }]}>
              <Text style={[styles.statusBadgeText, { color: session.closed_at ? Colors.textSecondary : Colors.success }]}>
                {session.closed_at ? 'Closed' : 'Active'}
              </Text>
            </View>
          </View>
          <Text style={styles.histMeta}>
            {formatTime(session.opening_time || session.opened_at)} {session.closed_at ? `— ${formatTime(session.closing_time || session.closed_at)}` : '— Now'}
          </Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={Colors.textLight} />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.histBody}>
          <View style={styles.histDivider} />
          
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Opening Balance</Text>
            <Text style={styles.detailVal}>₹{opening.toFixed(2)}</Text>
          </View>

          {session.closed_at && (
            <>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Cash Sales</Text>
                <Text style={[styles.detailVal, { color: Colors.success }]}>+₹{cashSales.toFixed(2)}</Text>
              </View>
              {cashRefunds > 0 && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Cash Refunds</Text>
                  <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{cashRefunds.toFixed(2)}</Text>
                </View>
              )}
              {helperFloats > 0 && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Change given to helpers</Text>
                  <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{helperFloats.toFixed(2)}</Text>
                </View>
              )}
              {helperHandovers > 0 && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Cash from helpers</Text>
                  <Text style={[styles.detailVal, { color: Colors.success }]}>+₹{helperHandovers.toFixed(2)}</Text>
                </View>
              )}
              {inferredExpenses > 0 ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Net Cash Expenses</Text>
                  <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{inferredExpenses.toFixed(2)}</Text>
                </View>
              ) : inferredExpenses < 0 ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Net Cash Returns</Text>
                  <Text style={[styles.detailVal, { color: Colors.success }]}>+₹{Math.abs(inferredExpenses).toFixed(2)}</Text>
                </View>
              ) : null}

              <View style={styles.histDivider} />
              
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expected Cash</Text>
                <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{expected.toFixed(2)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Actual Cash</Text>
                <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{actual.toFixed(2)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { fontWeight: '700', color: hasDiscrepancy ? Colors.error : Colors.text }]}>Discrepancy</Text>
                <Text style={[styles.detailVal, { 
                  fontWeight: '700', 
                  color: hasDiscrepancy ? Colors.error : Colors.success 
                }]}>
                  ₹{discrepancy.toFixed(2)}
                </Text>
              </View>

              {/* Non-cash metrics */}
              <View style={{ marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border, borderStyle: 'dashed' }}>
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { fontSize: FontSize.xs }]}>Card / UPI Sales</Text>
                  <Text style={[styles.detailVal, { fontSize: FontSize.xs, color: Colors.textSecondary }]}>
                    ₹{Number(session.total_card_sales || 0).toFixed(0)} / ₹{Number(session.total_upi_sales || 0).toFixed(0)}
                  </Text>
                </View>
              </View>
            </>
          )}

          <View style={[styles.histDivider, { marginTop: Spacing.sm }]} />
          <View style={styles.footerRow}>
            <View style={styles.userBadge}>
              <Ionicons name="person-circle" size={16} color={Colors.textLight} />
              <Text style={styles.userBadgeText}>Opened: {session.opened_by_name || 'Unknown'}</Text>
            </View>
            {session.closed_at && (
              <View style={styles.userBadge}>
                <Ionicons name="person-circle" size={16} color={Colors.textLight} />
                <Text style={styles.userBadgeText}>Closed: {session.closed_by_name || 'Unknown'}</Text>
              </View>
            )}
          </View>
          {session.closing_notes ? (
            <Text style={styles.notesText}>Notes: {session.closing_notes}</Text>
          ) : null}
        </View>
      )}
    </View>
  );
};

export default function CashRegisterScreen({ navigation, route }) {
  const { user, activeLocation } = useAuth();
  const initialLocationId = route.params?.locationId;
  const canManage = user?.role === 'owner' || user?.role === 'manager';
  // employee/counter_staff are the roles actually handling cash day-to-day
  // at the counter (opening/closing the register, taking cash sales,
  // logging expenses, receiving a delivery partner's COD handoff) — the
  // backend already trusts them with all of this, but several UI gates on
  // this screen were still canManage-only, leftover from before those
  // roles existed. Covers: the Expenses entry point (found live,
  // 2026-09-01 — "how would counter staff even add an expense with no way
  // to reach the screen?") and the pending-COD settle banner (same day,
  // sub-project 4 — matches settle-now's own widened role list).
  // "View History" (GET /register/history) stays canManage-only below —
  // that one really is owner/manager territory.
  const isCashHandlingStaff = canManage || user?.role === 'employee' || user?.role === 'counter_staff';
  const isOwner = user?.role === 'owner';

  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(initialLocationId || null);
  // The focus refresh below is created once, so it must read the shop from a
  // ref: reading the state there saw the first value and snapped back to the
  // first shop every time staff came back to this screen.
  const selectedLocationRef = useRef(selectedLocation);
  selectedLocationRef.current = selectedLocation;
  const [register, setRegister] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  // A4: the blind count fixed by an earlier close attempt (moves with floats
  // and handovers on the server), shown in the close box.
  const lockedCount = isOpen && register && register.close_count_locked != null && Number.isFinite(Number(register.close_count_locked))
    ? Number(register.close_count_locked) : null;
  const [loading, setLoading] = useState(true);

  const [openingBalance, setOpeningBalance] = useState('');
  // Last counted close (any day): fills in the opening cash
  const [lastClose, setLastClose] = useState(null);
  const openingTouched = useRef(false);
  const [actualCash, setActualCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [todaySessions, setTodaySessions] = useState([]);

  const [submitting, setSubmitting] = useState(false);
  // Close top-up: { excess, cash } while the panel is showing. The created
  // sale id is remembered so a failed close never books the extra cash twice.
  const [topup, setTopup] = useState(null);
  const topupSaleRef = useRef(null);
  const closingRef = useRef(false);
  const dropTopup = () => { topupSaleRef.current = null; setTopup(null); };
  // A top-up belongs to one location and one count; leaving either drops it.
  useEffect(() => { dropTopup(); }, [selectedLocation]);
  // Helper cash still out (bag mode): { cash, locationId, lines } while the
  // "still with <name>" warning shows before closing.
  const [bagWarn, setBagWarn] = useState(null);
  const [collectFor, setCollectFor] = useState(null);
  const [bagNote, setBagNote] = useState('');
  useEffect(() => { setBagWarn(null); setBagNote(''); }, [selectedLocation]);
  const guardSubmit = useSubmitGuard();
  const [pendingCodTotal, setPendingCodTotal] = useState(0);
  const [pendingCodDeliveries, setPendingCodDeliveries] = useState(0);

  // Open, but opened on a day before today — see isRegisterStale's own
  // comment (useRegisterStatus.js) for the full reasoning.
  const isStale = isOpen && isRegisterStale(register);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0) {
        // Keep the shop staff picked; else this device's shop (as Quick
        // Checkout does); else the first shop.
        const preferred = activeLocation && locs.find((l) => Number(l.id) === Number(activeLocation.id));
        const locId = selectedLocationRef.current || (preferred ? preferred.id : locs[0].id);
        setSelectedLocation(locId);
        fetchStatus(locId);
      }
    } catch {} finally { setLoading(false); }
  };

  const fetchStatus = async (locId) => {
    try {
      const res = await api.getRegisterStatus(locId);
      setRegister(res.data);
      setIsOpen(res.isOpen);
      // A4: a count already saved by an earlier close attempt goes in the box
      const locked = res.isOpen && res.data && res.data.close_count_locked != null ? Number(res.data.close_count_locked) : null;
      if (locked != null && Number.isFinite(locked)) {
        setActualCash((prev) => (prev === '' ? String(Math.round(locked * 100) / 100) : prev));
      }
      setTodaySessions(res.todaySessions || []);
      const last = res.isOpen ? null : lastCloseFromStatus(res);
      setLastClose(last);
      if (!openingTouched.current) setOpeningBalance(lastCloseCashText(last));
      setPendingCodTotal(res.pendingCodTotal || 0);
      setPendingCodDeliveries(res.pendingCodDeliveries || 0);
    } catch {}
  };

  const handleLocationChange = (locId) => {
    dropTopup();
    openingTouched.current = false;
    setSelectedLocation(locId);
    fetchStatus(locId);
  };

  const handleOpen = async () => {
    const balance = parseFloat(openingBalance);
    if (isNaN(balance) || balance < 0) {
      appAlert('Invalid', 'Enter a valid opening balance');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.openRegister({ location_id: selectedLocation, opening_balance: balance });
      if (res.success) {
        setRegister(res.data);
        setIsOpen(true);
        setOpeningBalance('');
        openingTouched.current = false;
        fetchStatus(selectedLocation);
        appAlert('Opened', 'Cash register opened successfully');
      } else {
        appAlert('Error', res.message);
      }
    } catch (err) {
      appAlert('Error', err.message || 'Failed to open register');
    } finally { setSubmitting(false); }
  };

  // Close flow. Tap Close -> preview (no writes). If the drawer holds at least
  // Rs 1 more than expected, show the top-up panel; otherwise the usual confirm.
  const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  // Server refused because the count was already fixed by an earlier offer.
  const handleCountLocked = (err) => {
    if (!(err && err.status === 409 && err.code === 'COUNT_LOCKED')) return false;
    const locked = err.body && err.body.locked_cash;
    dropTopup();
    if (locked != null) setActualCash(String(locked));
    showAlert('Count already entered', err.message || 'The cash count was already entered. Close with that amount.');
    return true;
  };

  const doClose = async (cash, locationId = selectedLocation) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setSubmitting(true);
    try {
      const res = await api.closeRegister({
        location_id: locationId,
        actual_cash: cash,
        closing_notes: closingNotes,
      });
      if (res.success) {
        topupSaleRef.current = null;
        setTopup(null);
        setRegister(res.data);
        setIsOpen(false);
        setActualCash('');
        setClosingNotes('');
        fetchStatus(selectedLocation);
        // discrepancy = expected - counted: above 0 the drawer was short,
        // below 0 it had extra. Say which, never a bare signed number.
        const diffPaise = Math.round(Number(res.data.discrepancy || 0) * 100);
        const diffText = `₹${(Math.abs(diffPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        showAlert('Register closed', diffPaise === 0
          ? 'The cash matched exactly.'
          : diffPaise > 0
            ? `The drawer was ${diffText} short.`
            : `The drawer had ${diffText} extra.`);
      } else {
        showAlert('Could not close', res.message || 'The register did not close. Please tap Close Register again.');
      }
    } catch (err) {
      if (handleCountLocked(err)) {
        // message shown, count put back
      } else if (err && (err.status === 404 || /not open|no open|open register/i.test(err.message || ''))) {
        dropTopup();
        fetchStatus(locationId);
        showAlert('Could not close', err.message || 'This register is no longer open.');
      } else
      showAlert('Could not close', 'The register did not close. Check your connection and tap Close Register again.');
    } finally { closingRef.current = false; setSubmitting(false); }
  };

  // Bag mode: helpers still holding cash when the register closes.
  // Returns the warning lines, or [] (also when the check itself fails:
  // closing must never wait on it).
  const helperCashOut = async (locationId) => {
    try {
      const res = await api.getHelperBags(locationId);
      if (!res || !res.data || res.data.mode !== 'bag' || !res.data.has_cash) return [];
      return closeWarningLines(res.data.bags);
    } catch (e) {
      return [];
    }
  };

  const handleClose = async () => {
    const cash = parseFloat(actualCash);
    if (isNaN(cash) || cash < 0) {
      showAlert('Invalid', 'Enter actual cash in drawer');
      return;
    }
    setSubmitting(true);
    const lines = await helperCashOut(selectedLocation);
    setSubmitting(false);
    if (lines.length > 0) {
      setBagNote('');
      setBagWarn({ cash, locationId: selectedLocation, lines });
      return;
    }
    await continueClose(cash);
  };

  // Close anyway: the bags stay open and carry over (the server records it).
  const handleCloseAnyway = async () => {
    if (!bagWarn) return;
    const { cash, locationId } = bagWarn;
    setBagWarn(null);
    if (selectedLocation !== locationId) return;
    await continueClose(cash);
  };

  const refreshBagWarn = async () => {
    const lines = await helperCashOut(selectedLocation);
    setBagWarn((w) => (w && lines.length > 0 ? { ...w, lines } : null));
  };

  const handleCollected = async (r) => {
    setActualCash('');
    setBagNote(`${handoverDoneText(r)} Put it in the drawer, count the drawer again, then tap Close Register.`);
    const lines = await helperCashOut(selectedLocation);
    setBagWarn((w) => (w && lines.length > 0 ? { ...w, lines } : null));
    fetchStatus(selectedLocation);
  };

  const continueClose = async (cash) => {
    setSubmitting(true);
    let preview = null;
    try {
      const res = await api.previewRegisterClose({ location_id: selectedLocation, actual_cash: cash });
      if (res && res.success && res.data) preview = res.data;
    } catch (e) {
      // preview is a nicety, closing must never wait on it, except a locked count
      if (handleCountLocked(e)) { setSubmitting(false); return; }
    }
    setSubmitting(false);

    const excess = preview ? Math.round(-Number(preview.discrepancy) * 100) / 100 : 0;
    if (preview && Number.isFinite(excess) && excess >= 1) {
      const pendingCod = Math.round(Number(preview.pending_cod || 0) * 100) / 100;
      const bookable = Math.round((excess - pendingCod) * 100) / 100;
      // Bag mode: extra cash in the drawer may be helper cash that was
      // handed over without Receive cash. Offer Collect now before booking.
      const bagLines = await helperCashOut(selectedLocation);
      setTopup({ excess, pendingCod, bookable, cash, locationId: selectedLocation, registerId: (register && register.id) || null, bagLines });
      return;
    }
    setTopup(null);
    showConfirm('Close Register', `Close register with ${rupees(cash)} actual cash?`, () => doClose(cash), { confirmLabel: 'Close' });
  };

  const handleBookTopup = async () => {
    if (!topup) return;
    const { bookable, cash, locationId } = topup;
    if (selectedLocation !== locationId) { dropTopup(); return; }
    const prev = topupSaleRef.current;
    if (!(prev && prev.cash === cash && prev.locationId === locationId)) {
      setSubmitting(true);
      // Look again right before booking: if the amount moved, show the new one
      // and let staff tap Book again instead of booking a stale figure.
      try {
        const fresh = await api.previewRegisterClose({ location_id: locationId, actual_cash: cash });
        if (fresh && fresh.success && fresh.data) {
          const freshExcess = Math.round(-Number(fresh.data.discrepancy) * 100) / 100;
          const freshCod = Math.round(Number(fresh.data.pending_cod || 0) * 100) / 100;
          const freshBookable = Math.round((freshExcess - freshCod) * 100) / 100;
          if (freshBookable !== bookable) {
            setSubmitting(false);
            if (freshExcess >= 1) {
              setTopup({ ...topup, excess: freshExcess, pendingCod: freshCod, bookable: freshBookable });
            } else {
              dropTopup();
            }
            showAlert('Amount changed', 'The amount changed since you counted. Please check the new amount and tap again.');
            return;
          }
        }
      } catch (e) { /* if the look-again fails, the booking below reports its own error */ }
      try {
        const payload = buildQuickSalePayload({
          locationId, method: 'cash', amount: bookable, label: TOPUP_LABEL, entryMode: 'close_topup',
        });
        const res = await api.createSale(payload);
        const id = res && (res.id != null ? res.id : res.data && res.data.id);
        if (!res || res.success === false || id == null) {
          setSubmitting(false);
          showAlert('Not booked', (res && res.message) || 'The extra cash was not booked. Please tap Book again.');
          return;
        }
        topupSaleRef.current = { saleId: id, cash, locationId };
      } catch (err) {
        setSubmitting(false);
        showAlert('Not booked', 'The extra cash was not booked. Check your connection and tap Book again.');
        return;
      }
      setSubmitting(false);
    }
    await doClose(cash, locationId);
  };

  // From the top-up panel: back to the "still with <name>" warning, whose
  // Collect now buttons open the blind handover for each helper.
  const handleTopupCollect = () => {
    if (!topup || !topup.bagLines || topup.bagLines.length === 0) return;
    const { cash, locationId, bagLines } = topup;
    dropTopup();
    if (selectedLocation !== locationId) return;
    setBagNote('');
    setBagWarn({ cash, locationId, lines: bagLines });
  };

  const handleCloseAsIs = async () => {
    if (!topup) return;
    if (selectedLocation !== topup.locationId) { dropTopup(); return; }
    await doClose(topup.cash, topup.locationId);
  };

  const fetchHistory = async () => {
    try {
      if (showHistory) {
        setShowHistory(false);
        return;
      }
      const res = await api.getRegisterHistory({ location_id: selectedLocation });
      setHistory(res.data || []);
      setShowHistory(true);
    } catch {}
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={Colors.primary} size="large" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {locations.length > 1 && (
        <View style={styles.locRow}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => handleLocationChange(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Pending COD Alert Banner — was canManage-only despite the backend
          allowing any authenticated role to read pendingCodTotal, and despite
          it being counter staff, not owner/manager, who physically take
          this cash handoff in practice. Widened to match settle-now's own
          role list (2026-09-01, sub-project 4). */}
      {isCashHandlingStaff && pendingCodTotal > 0 && (
        <TouchableOpacity
          style={styles.codBanner}
          onPress={() => navigation.navigate('Settlements', { locationId: selectedLocation })}
          activeOpacity={0.85}
        >
          <View style={styles.codBannerLeft}>
            <Ionicons name="alert-circle" size={20} color="#92400E" />
            <View>
              <Text style={styles.codBannerTitle}>Unsettled COD Cash</Text>
              <Text style={styles.codBannerSub}>
                ₹{Number(pendingCodTotal).toLocaleString('en-IN', { maximumFractionDigits: 0 })} from {pendingCodDeliveries} deliver{pendingCodDeliveries !== 1 ? 'ies' : 'y'} — not in register yet
              </Text>
            </View>
          </View>
          <View style={styles.codBannerAction}>
            <Text style={styles.codBannerActionText}>Settle</Text>
            <Ionicons name="chevron-forward" size={14} color="#92400E" />
          </View>
        </TouchableOpacity>
      )}

      {/* Card/UPI taken while the register was shut: no session counts it,
          so it is shown here on its own (it never belongs in the drawer). */}
      {register && !register.closed_at && register.shut_time_payments
        && (Number(register.shut_time_payments.upi) > 0 || Number(register.shut_time_payments.card) > 0) && (
        <View style={styles.shutInfo} accessibilityRole="text">
          <Ionicons name="information-circle" size={20} color={Colors.info || Colors.primary} />
          <Text style={styles.shutInfoText}>
            Taken while the register was shut:
            {Number(register.shut_time_payments.upi) > 0 ? ` UPI ₹${Number(register.shut_time_payments.upi).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ''}
            {Number(register.shut_time_payments.upi) > 0 && Number(register.shut_time_payments.card) > 0 ? ',' : ''}
            {Number(register.shut_time_payments.card) > 0 ? ` card ₹${Number(register.shut_time_payments.card).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ''}
            . This is not cash, so it is not in the drawer count.
          </Text>
        </View>
      )}

      {/* Main Status Hero. isStale (open, but not opened today — spans a day
          boundary) gets its own amber treatment rather than reading as a
          normal "Open" — this text used to unconditionally say "Opened
          today" even for a register left open from yesterday, an outright
          false claim on the one screen whose whole job is telling staff the
          truth about the register (found live, 2026-09-04 audit). Nothing
          about actually USING the register changes here — closing still
          requires a real physical cash count, so this is a heads-up, not a
          block; see isRegisterStale's own comment for why auto-closing
          isn't the answer. */}
      <View style={[
        styles.heroCard,
        isOpen ? (isStale ? styles.heroCardStale : styles.heroCardOpen) : styles.heroCardClosed
      ]}>
        <View style={styles.heroHeader}>
          <View style={[styles.heroIconWrap, isOpen ? { backgroundColor: isStale ? '#FEF3C7' : Colors.successLight } : { backgroundColor: Colors.surfaceAlt }]}>
            <Ionicons name={isOpen ? 'lock-open' : 'lock-closed'} size={28} color={isOpen ? (isStale ? '#92400E' : Colors.success) : Colors.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>{isOpen ? 'Register is Open' : 'Register is Closed'}</Text>
            <Text style={[styles.heroSub, isStale && { color: '#92400E', fontWeight: '600' }]}>
              {register ? (
                isOpen ? `Opened ${formatDateLabel(register.opening_time || register.opened_at)} at ${formatTime(register.opening_time || register.opened_at)}`
                       : `Last closed at ${formatTime(register.closing_time || register.closed_at)}`
              ) : 'No recent sessions'}
            </Text>
            {isStale && (
              <Text style={[styles.heroSub, { color: '#92400E', marginTop: 2 }]}>Nothing's blocked — close it out whenever you get a chance.</Text>
            )}
          </View>
        </View>

        {register && isOpen && (
          <View style={styles.heroBody}>
            {isOwner ? (
              <View style={styles.liveCalculation}>
                <Text style={styles.liveCalcTitle}>Live Expected Cash</Text>
                
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opening Balance</Text>
                  <Text style={styles.calcVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
                </View>
                
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>+ Cash Sales</Text>
                  <Text style={[styles.calcVal, { color: Colors.success }]}>₹{Number(register.total_cash_sales || 0).toFixed(2)}</Text>
                </View>

                {Number(register.total_refunds_cash || 0) > 0 && (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>- Cash Refunds</Text>
                    <Text style={[styles.calcVal, { color: Colors.error }]}>₹{Number(register.total_refunds_cash).toFixed(2)}</Text>
                  </View>
                )}

                {Number(register.total_expenses_cash || 0) > 0 ? (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>- Net Cash Expenses</Text>
                    <Text style={[styles.calcVal, { color: Colors.error }]}>₹{Number(register.total_expenses_cash).toFixed(2)}</Text>
                  </View>
                ) : Number(register.total_expenses_cash || 0) < 0 ? (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>+ Net Cash Returns</Text>
                    <Text style={[styles.calcVal, { color: Colors.success }]}>₹{Math.abs(Number(register.total_expenses_cash)).toFixed(2)}</Text>
                  </View>
                ) : null}

                {Number(register.helper_floats || 0) > 0 && (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>- Change given to helpers</Text>
                    <Text style={[styles.calcVal, { color: Colors.error }]}>₹{Number(register.helper_floats).toFixed(2)}</Text>
                  </View>
                )}
                {Number(register.helper_handovers || 0) > 0 && (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>+ Cash from helpers</Text>
                    <Text style={[styles.calcVal, { color: Colors.success }]}>₹{Number(register.helper_handovers).toFixed(2)}</Text>
                  </View>
                )}

                <View style={styles.calcDivider} />
                <View style={styles.calcRow}>
                  <Text style={styles.calcTotalLabel}>Expected in Drawer</Text>
                  <Text style={styles.calcTotalVal}>
                    {/* The server keeps expected_cash for the open session
                        (sales, refunds, expenses, helper floats and cash);
                        the sum of the lines above is only a fallback. */}
                    ₹{(
                      register.expected_cash != null && Number.isFinite(Number(register.expected_cash))
                        ? Number(register.expected_cash)
                        : Number(register.opening_balance || 0) +
                          Number(register.total_cash_sales || 0) -
                          Number(register.total_refunds_cash || 0) -
                          Number(register.total_expenses_cash || 0) -
                          Number(register.helper_floats || 0) +
                          Number(register.helper_handovers || 0)
                    ).toFixed(2)}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={{ gap: Spacing.sm }}>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opening Balance</Text>
                  <Text style={styles.calcVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
                </View>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opened By</Text>
                  <Text style={styles.calcVal}>{register.opened_by_name || 'Unknown'}</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Forms */}
      {!isOpen && (
        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Start New Session</Text>
          <View style={styles.formCard}>
            <Text style={styles.formLabel}>Opening Cash Balance</Text>
            <View style={styles.inputWrap}>
              <Text style={styles.inputSymbol}>₹</Text>
              <TextInput
                style={styles.inputLarge}
                value={openingBalance}
                onChangeText={(t) => { openingTouched.current = true; setOpeningBalance(t); }}
                placeholder="0.00"
                placeholderTextColor={Colors.textLight}
                keyboardType="numeric"
                accessibilityLabel="Opening cash in the drawer"
              />
            </View>
            {lastClose != null && (
              <Text style={styles.prefillHint}>{lastCloseHint(lastClose)}</Text>
            )}
            <TouchableOpacity style={[styles.btnOpen, submitting && { opacity: 0.6 }]} onPress={handleOpen} disabled={submitting}>
              {submitting ? <ActivityIndicator color={Colors.white} /> : (
                <Text style={styles.btnOpenText}>Open Register</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {isOpen && (
        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Close Session</Text>
          <View style={styles.formCard}>
            <Text style={styles.formLabel}>Actual Cash in Drawer</Text>
            <View style={styles.inputWrap}>
              <Text style={styles.inputSymbol}>₹</Text>
              <TextInput
                style={styles.inputLarge}
                value={actualCash}
                onChangeText={(t) => { setActualCash(t); dropTopup(); setBagWarn(null); }}
                editable={!((topup || lockedCount != null) && !canManage)}
                placeholder="0.00"
                placeholderTextColor={Colors.textLight}
                keyboardType="numeric"
                accessibilityLabel="Actual cash in drawer"
              />
            </View>
            {lockedCount != null && (
              <View style={styles.countSaved}>
                <Ionicons name="lock-closed" size={18} color={Colors.textSecondary} />
                <Text style={styles.countSavedText}>
                  {canManage
                    ? `Count saved: ${rupees(lockedCount)}. You can change it if the drawer was counted wrong.`
                    : `Count saved: ${rupees(lockedCount)}. Close with this amount, or ask a manager to close the register.`}
                </Text>
              </View>
            )}
            
            {!!bagNote && (
              <View style={styles.bagNote}>
                <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
                <Text style={styles.bagNoteText}>{bagNote}</Text>
              </View>
            )}

            <Text style={[styles.formLabel, { marginTop: Spacing.md }]}>Closing Notes (optional)</Text>
            <TextInput
              style={styles.inputArea}
              value={closingNotes}
              onChangeText={setClosingNotes}
              placeholder="Any discrepancies or notes..."
              placeholderTextColor={Colors.textLight}
              multiline
            />
            
            {topup ? (
              <View style={styles.topupPanel}>
                {!canManage ? (
                  <Text style={styles.topupNote}>Your count of {rupees(topup.cash)} is saved and cannot be changed now.</Text>
                ) : null}
                <Text style={styles.topupText}>{rupees(topup.excess)} more than recorded.{topup.bookable >= 1 ? (topup.pendingCod > 0 ? ` Book the other ${rupees(topup.bookable)} as unrecorded sales?` : ' Book it as unrecorded sales?') : ''}</Text>
                {topup.bagLines && topup.bagLines.length > 0 ? (
                  <View>
                    <Text style={styles.topupNote}>Did a helper give you cash? Tap Collect now first.</Text>
                    <TouchableOpacity
                      style={[styles.topupNo, submitting && { opacity: 0.6 }]}
                      onPress={handleTopupCollect}
                      disabled={submitting}
                      accessibilityRole="button"
                      accessibilityLabel="Collect now from helpers"
                    >
                      <Text style={styles.topupNoText}>Collect now</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {topup.pendingCod > 0 ? (
                  <View>
                    <Text style={styles.topupNote}>{rupees(topup.pendingCod)} of delivery cash is not settled yet and may be in the drawer. Settle it first.</Text>
                    <TouchableOpacity
                      style={styles.topupNo}
                      onPress={() => { dropTopup(); navigation.navigate('Settlements', { locationId: selectedLocation }); }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.topupNoText}>Settle</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {topup.bookable < 1 ? null : amountError(topup.bookable) ? (
                  <Text style={styles.topupNote}>That is too big to book here. Close as it is, or count the cash again.</Text>
                ) : (
                  <TouchableOpacity
                    style={[styles.topupBook, submitting && { opacity: 0.6 }]}
                    onPress={guardSubmit(handleBookTopup)}
                    disabled={submitting}
                    accessibilityRole="button"
                  >
                    {submitting ? <ActivityIndicator color={Colors.white} /> : (
                      <Text style={styles.btnCloseText}>Book {rupees(topup.bookable)} as sales</Text>
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.topupNo, submitting && { opacity: 0.6 }]}
                  onPress={guardSubmit(handleCloseAsIs)}
                  disabled={submitting}
                  accessibilityRole="button"
                >
                  <Text style={styles.topupNoText}>No, close as it is</Text>
                </TouchableOpacity>
              </View>
            ) : bagWarn ? (
              <View style={styles.bagPanel}>
                {bagWarn.lines.map((l) => (
                  <View key={l.staff_id} style={styles.bagLine}>
                    <Ionicons name="wallet-outline" size={22} color={Colors.text} />
                    <Text style={styles.bagText}>{l.text}</Text>
                    <TouchableOpacity
                      style={styles.bagCollect}
                      onPress={() => setCollectFor({ staff_id: l.staff_id, name: l.name })}
                      accessibilityRole="button"
                      accessibilityLabel={`Collect now from ${l.name}`}
                    >
                      <Text style={styles.btnCloseText}>Collect now</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity
                  style={[styles.topupNo, submitting && { opacity: 0.6 }]}
                  onPress={guardSubmit(handleCloseAnyway)}
                  disabled={submitting}
                  accessibilityRole="button"
                >
                  <Text style={styles.topupNoText}>Close anyway</Text>
                </TouchableOpacity>
                <Text style={styles.topupNote}>Close anyway keeps the cash with the helper for the next session.</Text>
              </View>
            ) : (
            <TouchableOpacity style={[styles.btnClose, submitting && { opacity: 0.6 }]} onPress={guardSubmit(handleClose)} disabled={submitting}>
              {submitting ? <ActivityIndicator color={Colors.white} /> : (
                <Text style={styles.btnCloseText}>Close Register</Text>
              )}
            </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* Actions */}
      {(isCashHandlingStaff || canManage) && (
        <View style={styles.actionRow}>
          {isCashHandlingStaff && (
            <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('Expenses', { locationId: selectedLocation })}>
              <View style={[styles.actionIconWrap, { backgroundColor: Colors.infoLight }]}>
                <Ionicons name="wallet" size={20} color={Colors.info} />
              </View>
              <Text style={styles.actionBtnText}>Expenses</Text>
            </TouchableOpacity>
          )}
          {canManage && (
            <TouchableOpacity style={styles.actionBtn} onPress={fetchHistory}>
              <View style={[styles.actionIconWrap, { backgroundColor: Colors.primaryLight }]}>
                <Ionicons name="list" size={20} color={Colors.primary} />
              </View>
              <Text style={styles.actionBtnText}>{showHistory ? 'Hide History' : 'View History'}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* History Sections */}
      {todaySessions.length > 0 && !showHistory && (
        <View style={styles.listSection}>
          <Text style={styles.sectionTitle}>Today's Sessions</Text>
          {todaySessions.map((s, idx) => (
            <HistoryCard key={`today-${s.id}`} session={s} isToday={true} />
          ))}
        </View>
      )}

      {showHistory && history.length > 0 && (
        <View style={styles.listSection}>
          <Text style={styles.sectionTitle}>Register History</Text>
          {history.map((h) => (
            <HistoryCard key={`hist-${h.id}`} session={h} isToday={false} />
          ))}
        </View>
      )}

      <View style={{ height: 60 }} />
      <ReceiveCashSheet
        visible={!!collectFor}
        helper={collectFor}
        locationId={selectedLocation}
        onClose={() => setCollectFor(null)}
        onDone={handleCollected}
        onStale={refreshBagWarn}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  countSaved: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    marginTop: Spacing.sm, padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.background,
  },
  countSavedText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  prefillHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: -Spacing.xs, marginBottom: Spacing.md },
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, maxWidth: 800, alignSelf: 'center', width: '100%' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },

  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.lg },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.text, borderColor: Colors.text },
  locChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  locChipTextActive: { color: Colors.white },

  shutInfo: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: Colors.white, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  shutInfoText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  codBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FEF3C7', borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: '#FDE68A',
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  codBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  codBannerTitle: { fontSize: FontSize.sm, fontWeight: '700', color: '#92400E' },
  codBannerSub: { fontSize: FontSize.xs, color: '#92400E', marginTop: 2, opacity: 0.8 },
  codBannerAction: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FDE68A', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: BorderRadius.sm,
  },
  codBannerActionText: { fontSize: FontSize.xs, fontWeight: '700', color: '#92400E' },


  heroCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    ...Shadows.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
  },
  heroCardOpen: { borderColor: Colors.successLight },
  heroCardStale: { borderColor: '#FDE68A', backgroundColor: '#FFFBEB' },
  heroCardClosed: { borderColor: Colors.border },
  
  heroHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  heroIconWrap: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  heroSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  
  heroBody: { marginTop: Spacing.lg, paddingTop: Spacing.lg, borderTopWidth: 1, borderTopColor: Colors.border },
  
  liveCalculation: { backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: Spacing.md },
  liveCalcTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm },
  calcRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  calcLabel: { fontSize: FontSize.sm, color: Colors.text },
  calcVal: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  calcDivider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  calcTotalLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  calcTotalVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },

  formSection: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginBottom: Spacing.sm },
  formCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.lg, ...Shadows.sm, borderWidth: 1, borderColor: Colors.border
  },
  formLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },
  
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  inputSymbol: { fontSize: FontSize.xl, fontWeight: '500', color: Colors.textSecondary, marginRight: Spacing.sm },
  inputLarge: {
    flex: 1, fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    paddingVertical: Spacing.md, minHeight: TouchTarget.minHeight,
  },
  inputArea: {
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, fontSize: FontSize.md, color: Colors.text,
    minHeight: 80, textAlignVertical: 'top',
  },

  btnOpen: { backgroundColor: Colors.text, borderRadius: BorderRadius.md, padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg },
  btnOpenText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  btnClose: { backgroundColor: Colors.error, borderRadius: BorderRadius.md, padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg },
  topupPanel: { marginTop: Spacing.lg, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: Spacing.md },
  topupText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  topupNote: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  topupBook: { backgroundColor: METHOD_COLOR.cash, borderRadius: BorderRadius.md, minHeight: TouchTarget.min || 48, padding: Spacing.md, alignItems: 'center', justifyContent: 'center' },
  topupNo: { borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, minHeight: TouchTarget.min || 48, padding: Spacing.md, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm },
  topupNoText: { color: Colors.text, fontSize: FontSize.md, fontWeight: '600' },
  btnCloseText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  bagPanel: { marginTop: Spacing.lg, backgroundColor: Colors.warningLight, borderRadius: BorderRadius.md, padding: Spacing.md, gap: Spacing.sm },
  bagLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm },
  bagText: { flex: 1, minWidth: 180, fontSize: FontSize.md, fontWeight: '600', color: Colors.text, lineHeight: 22 },
  bagCollect: { backgroundColor: Colors.success, borderRadius: BorderRadius.md, minHeight: 48, paddingHorizontal: Spacing.md, alignItems: 'center', justifyContent: 'center' },
  bagNote: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, marginTop: Spacing.sm, padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight },
  bagNoteText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },

  actionRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, ...Shadows.sm
  },
  actionIconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  actionBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },

  listSection: { gap: Spacing.sm },
  histCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border, ...Shadows.sm,
    overflow: 'hidden',
  },
  histHeaderBtn: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, backgroundColor: Colors.surface },
  histDate: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: BorderRadius.full },
  statusBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  histMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  
  histBody: { padding: Spacing.md, paddingTop: 0, backgroundColor: Colors.surfaceAlt },
  histDivider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  detailLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  detailVal: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: Spacing.sm },
  userBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  userBadgeText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  notesText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic', marginTop: Spacing.sm },
});
