import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import useBreakpoint from '../hooks/useBreakpoint';
import api from '../services/api';
import { showAlert } from '../utils/alert';
import { Colors, FontSize, Spacing } from '../constants/theme';
import { parseServerDate, getShopNow, getShopTodayStr, DEFAULT_TZ, formatTimeString, formatDateLabel } from '../utils/datetime';
import { isRegisterStale } from '../hooks/useRegisterStatus';
import { OrderQuickModal } from '../components/QuickModals';
import OrderKanbanBoard from '../components/orderBoard/OrderKanbanBoard';
import AssignPickerModal from '../components/orderBoard/AssignPickerModal';
import DeliveryChecklist from '../components/DeliveryChecklist';
// The one place the "does starting this need a preparer, and who decides?"
// rule lives. Imported rather than restated so this screen, the order card and
// the order modal cannot drift apart on it (Task 15 review).
import { resolvePreparerStep } from '../components/orderBoard/OrderCard';
import DateTimePickerModal from '../components/DateTimePickerModal';
import AttachmentVoiceRow from '../components/AttachmentVoiceRow';
import ImageModal from '../components/ImageModal';
import {
  ORDER_TYPES,
  ORDER_STATUS_LABELS,
  TASK_STATUS_LABELS,
  DELIVERY_STATUS_COLORS,
  DELIVERY_STATUS_LABELS,
  FONT_FAMILY,
  formatMoney,
  getTaskChipColor,
  STAFF_ROLE_LABELS,
  PREP_ROLES,
} from '../constants/orderDisplay';

function RegisterCard({ item, onPress, onSettlePress }) {
  const { locationName, isOpen, register, pendingCodTotal, pendingCodDeliveries } = item;
  // Open but opened before today (spans a day boundary) gets its own amber
  // tone instead of reading as a plain, healthy "OPEN" — same reasoning as
  // CashRegisterScreen.js's hero card (isRegisterStale's own comment has the
  // full story). Nothing here blocks anything; it's a heads-up.
  const isStale = isOpen && isRegisterStale(register);
  const tone = isOpen ? (isStale ? '#D97706' : '#10B981') : '#E11D48';
  const codPending = Number(pendingCodTotal || 0) > 0;
  return (
    <TouchableOpacity
      style={[styles.registerCard, { borderLeftColor: tone, borderLeftWidth: 4 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Text style={styles.registerTitle}>{locationName}</Text>
          <Text style={[styles.registerStatus, { color: tone }]}>
            {isOpen ? (isStale ? `● OPEN since ${formatDateLabel(register?.opening_time || register?.opened_at)}` : '● OPEN') : '● CLOSED'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.registerLabel}>Expected</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.expected_cash || 0)}</Text>
        </View>
      </View>
      <View style={[styles.divider, { backgroundColor: tone + '20' }]} />
      <View style={[styles.rowBetween, { marginTop: 8 }]}>
        <View>
          <Text style={styles.registerLabel}>Opening</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.opening_balance || 0)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.registerLabel}>Cash Sales</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.total_cash_sales || 0)}</Text>
        </View>
      </View>
      {/* Money a delivery partner has collected for THIS location but hasn't
          handed over yet. Existed in the pre-redesign dashboard (V2) as a
          per-register alert; dropped when RegisterCard was rewritten — the
          owner's registerCalls map never extracted pendingCodTotal/
          pendingCodDeliveries from getRegisterStatus()'s response even
          though the counter_staff/employee branches read the exact same
          call's fields (see registerCalls above). Restored 2026-09-04, same
          "which location" context (locationName above), matching the
          compact banner counter staff already have on their own dashboard. */}
      {codPending && (
        <TouchableOpacity
          style={[styles.codBannerCompact, { marginTop: 8 }]}
          onPress={onSettlePress}
          activeOpacity={0.75}
        >
          <Ionicons name="alert-circle" size={18} color="#92400E" />
          <Text style={styles.codBannerCompactText}>
            ₹{Number(pendingCodTotal).toLocaleString('en-IN', { maximumFractionDigits: 0 })} from {pendingCodDeliveries} deliver{pendingCodDeliveries !== 1 ? 'ies' : 'y'} not settled — Settle Now
          </Text>
          <Ionicons name="chevron-forward" size={16} color="#92400E" />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

function StaffPulseRow({ staff }) {
  const tone = staff.pulse === 'active' ? '#10B981' : staff.pulse === 'busy' ? '#F59E0B' : '#9CA3AF';
  const bgTone = staff.pulse === 'active' ? '#F0FDF4' : staff.pulse === 'busy' ? '#FEF3C7' : '#F3F4F6';
  return (
    <View style={[styles.staffRow, { backgroundColor: bgTone, borderLeftColor: tone, borderLeftWidth: 3 }]}>
      <View style={[styles.staffRing, { borderColor: tone, backgroundColor: tone + '1a' }]}>
        <Ionicons name="person" size={13} color={tone} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.staffName}>{staff.name}</Text>
        <Text style={styles.staffMeta}>{staff.roleLabel}</Text>
        {!!staff.detail && <Text style={styles.staffMetaSub}>{staff.detail}</Text>}
      </View>
      <View style={[styles.pulseBadge, { backgroundColor: tone + '20', borderColor: tone }]}>
        <Text style={[styles.pulseBadgeText, { color: tone }]}>{staff.pulseLabel}</Text>
      </View>
    </View>
  );
}

function TaskDetailModal({ visible, task, onClose, onAdvance, loading }) {
  if (!task) return null;
  
  const color = getTaskChipColor(task.status);
  const isFinal = task.status === 'completed' || task.status === 'cancelled';
  const nextStatus = task.status === 'pending' ? 'Assign' : 
                     task.status === 'assigned' ? 'Start' : 
                     task.status === 'in_progress' ? 'Complete' : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.taskModalCard}>
          <View style={styles.modalHeader}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <Text style={styles.modalTitle}>{task.product_name || task.item_product_name || 'Task'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={5}>
              <Ionicons name="close" size={20} color="#6B7280" />
            </TouchableOpacity>
          </View>

          <View style={styles.modalContent}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Current Status</Text>
              <View style={[styles.statusPill, { backgroundColor: color + '20', borderColor: color }]}>
                <Text style={[styles.statusPillText, { color }]}>{TASK_STATUS_LABELS[task.status] || task.status}</Text>
              </View>
            </View>

            {task.custom_materials && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Materials</Text>
                <Text style={styles.detailValue}>{task.custom_materials}</Text>
              </View>
            )}

            {task.special_instructions && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Instructions</Text>
                <Text style={styles.detailValue}>{task.special_instructions}</Text>
              </View>
            )}

            {task.sale_number && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Order #</Text>
                <Text style={styles.detailValue}>{task.sale_number}</Text>
              </View>
            )}
          </View>

          {!isFinal && nextStatus && (
            <TouchableOpacity
              disabled={loading}
              onPress={() => onAdvance(task)}
              style={[styles.advanceButton, { opacity: loading ? 0.6 : 1, backgroundColor: color }]}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="arrow-forward" size={16} color="#fff" />
                  <Text style={styles.advanceButtonText}>{nextStatus} Task</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {isFinal && (
            <View style={[styles.advanceButton, { backgroundColor: '#E5E7EB' }]}>
              <Ionicons name="checkmark-circle" size={16} color="#6B7280" />
              <Text style={[styles.advanceButtonText, { color: '#6B7280' }]}>Task {task.status === 'completed' ? 'Completed' : 'Cancelled'}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

export default function DashboardScreen({ navigation }) {
  // Page-layout threshold (1100), deliberately NOT the board's 900 — see the
  // doc comment in hooks/useBreakpoint.js for why these are two numbers.
  const { isDesktop } = useBreakpoint();
  const { user, activeLocation, settings, locked } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fabVisible, setFabVisible] = useState(false);
  const [viewedImage, setViewedImage] = useState(null); // task-card product photo, tap to enlarge
  const [selectedTaskModal, setSelectedTaskModal] = useState(null);
  const [selectedOrderModal, setSelectedOrderModal] = useState(null); // { order, tasks }
  // { deliveryId, saleId, loading, people, showingEveryone } while the
  // assign-a-rider picker is open, null when it is closed (Task 14).
  const [riderPicker, setRiderPicker] = useState(null);
  // Monotonic request token for everything the picker awaits. Bumped when a
  // request STARTS and when the picker CLOSES; a resolved promise applies its
  // result only if the token still matches, so a slow response can never
  // reopen a closed picker or overwrite a newer one's deliveryId. Every bump
  // is paired with an owner that ends in a settled state (a fresh
  // loading:true request, or null), so a discarded response can never strand
  // the picker mid-spinner.
  const riderReqRef = useRef(0);
  // { order, mode, loading, people } while the who-is-making-this picker is
  // open, null when it is closed (Task 15). `mode` is 'start' when picking
  // also starts preparation (the Start Preparing action carries assigned_to),
  // or 'assign' when the order is already preparing and this is purely a
  // correction — see handleResolveAction's pick_preparer branch.
  const [preparerPicker, setPreparerPicker] = useState(null);
  // Same monotonic request token as riderReqRef above, for the same reasons and
  // with the same pairing rule (every bump is owned by something that settles).
  // Without it: cancelling during the staff-list fetch reopens the picker the
  // person just dismissed; and open-A, cancel, open-B, with A resolving last,
  // rebuilds the whole state object from A's closure — the title is static, so
  // the modal still LOOKS like B while pointing at A, and the next tap acts on
  // A. In 'start' mode that flips a live sale to preparing.
  const preparerReqRef = useRef(0);

  // { order, amount, method, reference, loading } while the Mark Delivered
  // COD-entry prompt is open, null when closed — see resolveDeliverStep
  // (OrderCard.js) and handleResolveAction's 'collect_cod' branch. Same
  // shape/purpose as preparerPicker above, one level simpler: no staff list
  // to fetch, just a form, so it opens filled-in rather than loading.
  const [codCollectPicker, setCodCollectPicker] = useState(null);
  // The order whose load checklist is open in a modal, null when closed —
  // OrderCard's load pill (onVerifyLoad). Holds the whole order (not just a
  // delivery id) so the modal's title can name the order.
  const [loadChecklistOrder, setLoadChecklistOrder] = useState(null);

  const [locations, setLocations] = useState([]);
  const [locationScope, setLocationScope] = useState(null);
  const [dateScope, setDateScope] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [sales, setSales] = useState([]);
  const [taskRows, setTaskRows] = useState([]);
  // Real count of orders completed TODAY (shop timezone), independent of
  // whatever the board's own `sales`/`counterPendingOrders` fetch contains —
  // see the "Done today" chip on OrderKanbanBoard. Both role branches below
  // fetch it directly with status=completed&limit=1 and read the API's
  // accurate `total`, rather than deriving it by counting whatever happens
  // to already be in the open-orders array.
  const [doneTodayCount, setDoneTodayCount] = useState(0);
  const [staffPulse, setStaffPulse] = useState([]);
  const [registers, setRegisters] = useState([]);
  const [reportKPIs, setReportKPIs] = useState(null);

  const [taskActionLoading, setTaskActionLoading] = useState({});

  // Role-specific dashboard state
  const [myTasks, setMyTasks] = useState([]); // employee's/florist's own production tasks
  const [myDeliveries, setMyDeliveries] = useState([]); // delivery partner's own deliveries
  const [counterStats, setCounterStats] = useState({ salesCount: 0, registerOpen: null, registerOpenedBy: null, registerOpenedAt: null });
  const [counterPendingOrders, setCounterPendingOrders] = useState([]);

  const role = user?.role;
  const isOwner = role === 'owner';
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee' || role === 'counter_staff' || role === 'florist_staff';
  const isOwnerOrManager = role === 'owner' || role === 'manager';
  // Production-task dashboard: today's generic `employee` bucket (unmigrated
  // accounts) and `florist_staff` (prep is their whole job). `counter_staff`
  // gets its own sales-focused view below — its job is checkout/orders, not
  // production, so the task queue was the wrong default here (see counter
  // staff dashboard discussion, 2026-08-31).
  const isEmployee = role === 'employee' || role === 'florist_staff';
  const isCounterStaff = role === 'counter_staff';
  const isDeliveryPartner = role === 'delivery_partner';
  // Customers reach this screen too: MainNavigator.js registers the Dashboard
  // tab with NO role gate, so `customer` gets Shop and MyOrders *in addition
  // to* Home, not instead of it. Without this flag `role === 'customer'`
  // matched none of the tests above and fell through to the owner/manager
  // branch — fetching shop-wide sales onto a customer's device and rendering
  // them on the operations board. Both halves are closed below: the fetch
  // (fetchDashboard's early return) and the render (the isCustomer branch).
  const isCustomer = role === 'customer';
  // NOTE: the card pulse-border animation (pulseAnim/pulseOpacity) that used
  // to live here moved into the old components/OrderKanbanBoard.js along with
  // OrderCard, the only thing that ever consumed it (Task 9, order-lifecycle
  // plan, 2026-09-01). Both that file and the animation are gone now — the
  // Stage board's OrderCard does not pulse. Kept as a breadcrumb only.

  const fetchDashboard = useCallback(async () => {
    try {
      // ─── Customer: fetch nothing ─────────────────────────────
      // Deliberately first, and deliberately before any request: this screen
      // has no customer-facing data to show, and GET /api/sales has no
      // server-side role guard (CLAUDE.md), so issuing the shop-wide sales
      // request here would put every order in the shop on a customer's
      // device. Their own orders live on the MyOrders tab.
      if (isCustomer) {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Delivery Partner: lightweight fetch ─────────────────
      if (isDeliveryPartner) {
        const [delivRes, unsettledRes] = await Promise.all([
          api.getDeliveries({ status: 'active' }).catch(() => ({ data: [] })),
          api.getUnsettledDeliveries({}).catch(() => ({ data: { deliveries: [], total_unsettled: 0 } })),
        ]);
        setMyDeliveries(delivRes?.data || []);
        const unsettledData = unsettledRes?.data || {};
        setReportKPIs({ unsettledTotal: Number(unsettledData.total_unsettled || 0), unsettledCount: (unsettledData.deliveries || []).length });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Employee: task-focused fetch ────────────────────────
      if (isEmployee) {
        const [myTasksRes, allTasksRes] = await Promise.all([
          api.getMyTasks().catch(() => ({ data: [] })),
          api.getProductionTasks({}).catch(() => ({ data: [] })),
        ]);
        setMyTasks(myTasksRes?.data || []);
        setTaskRows(allTasksRes?.data || []);
        // Plain `employee` (unlike florist_staff) has the POS tab and takes
        // cash payments, so it has the exact same register-reachability
        // need counter_staff does — reusing counterStats' register fields
        // rather than adding a parallel state (2026-09-01 follow-up to the
        // counter_staff fix). florist_staff never touches payments, so it
        // skips this fetch entirely.
        if (role === 'employee' && activeLocation?.id) {
          const registerRes = await api.getRegisterStatus(activeLocation.id).catch(() => ({}));
          setCounterStats((prev) => ({
            ...prev,
            registerOpen: registerRes?.data ? !registerRes.data.closed_at : null,
            registerOpenedBy: registerRes?.data?.opened_by_name || null,
            registerOpenedAt: registerRes?.data?.opening_time || registerRes?.data?.opened_at || null,
            pendingCodTotal: Number(registerRes?.pendingCodTotal || 0),
            pendingCodDeliveries: Number(registerRes?.pendingCodDeliveries || 0),
          }));
        }
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Counter Staff: sales-focused fetch (counts/status only —
      // no revenue totals or cash amounts, per role scope) ──────
      if (isCounterStaff) {
        const [summaryRes, registerRes, pendingRes, confirmedRes, preparingRes, readyRes, tasksRes, doneTodayRes] = await Promise.all([
          api.getTodaySummary(activeLocation?.id).catch(() => ({ data: { total_sales: 0 } })),
          activeLocation?.id ? api.getRegisterStatus(activeLocation.id).catch(() => ({ data: null })) : Promise.resolve({ data: null }),
          // Fetched wider than the 5 we display so the today/future split
          // below has real data to count against, not just the first 5
          // pending orders regardless of date (2026-08-31 fix).
          api.getSales({ status: 'pending', location_id: activeLocation?.id, limit: 30 }).catch(() => ({ data: { sales: [] } })),
          // 'confirmed' is pending-equivalent everywhere (the kanban buckets
          // it into the same lane as pending, and computeOrderStage() now
          // returns the same 'new' stage for it) — it's what a reattempted
          // delivery is set to. Without its own call it never reached this
          // dashboard at all (2026-09-01 final-review fix, alongside 'ready').
          api.getSales({ status: 'confirmed', location_id: activeLocation?.id, limit: 30 }).catch(() => ({ data: { sales: [] } })),
          // GET /sales only takes one status value per call, so 'preparing'
          // needs its own request. Without this, an order advanced out of
          // 'pending' vanished from the dashboard entirely — no way to see
          // it again to mark it Ready once prep finished (2026-09-01 fix,
          // alongside adding the "Mark Ready"/"Start Preparing" quick
          // actions these two statuses need).
          api.getSales({ status: 'preparing', location_id: activeLocation?.id, limit: 30 }).catch(() => ({ data: { sales: [] } })),
          // Same one-status-per-call reason as 'preparing' above: without its
          // own request, an order marked Ready vanished from this dashboard,
          // leaving the Ready / Out-for-Delivery kanban lanes permanently
          // empty for counter staff — so "Confirm Pickup"/"Mark Delivered"
          // could never appear here even though counter staff are exactly
          // who hands a ready order over (2026-09-01 final-review fix).
          api.getSales({ status: 'ready', location_id: activeLocation?.id, limit: 30 }).catch(() => ({ data: { sales: [] } })),
          // Production tasks, needed so OrderKanbanBoard's per-card task
          // pills/pipeline counts (Task 11, order-lifecycle plan — rebuilding
          // this dashboard onto the kanban board) reflect real prep state
          // instead of always reading empty. Same endpoint/call the isEmployee
          // branch above uses; GET /production/tasks already authorizes
          // counter_staff and auto-scopes to their assigned location(s)
          // server-side, and carries no cost/margin fields (verified against
          // attachMaterialsToTasks in server/routes/production.js).
          api.getProductionTasks({}).catch(() => ({ data: [] })),
          // "Done today" chip: this dashboard's four fetches above only ever
          // request pending/confirmed/preparing/ready, so a completed order
          // never enters counterPendingOrders and the chip's count was always
          // 0 by construction, not merely 0 today — no live data state could
          // ever have populated it. One row is enough; GET /sales computes an
          // accurate `total` regardless of `limit`.
          api.getSales({ status: 'completed', location_id: activeLocation?.id, filter_date: getShopTodayStr(DEFAULT_TZ), limit: 1 })
            .catch(() => ({ data: { total: 0 } })),
        ]);
        setCounterStats({
          salesCount: Number(summaryRes?.data?.total_sales || 0),
          registerOpen: registerRes?.data ? !registerRes.data.closed_at : null,
          registerOpenedBy: registerRes?.data?.opened_by_name || null,
          registerOpenedAt: registerRes?.data?.opening_time || registerRes?.data?.opened_at || null,
          // Money a delivery partner has collected (cash or UPI) but hasn't
          // handed over/been settled yet — was only ever shown on
          // CashRegisterScreen, and only to owner/manager there, so
          // counter staff (who actually take this handoff) had no
          // visibility into it at all until they happened to navigate deep
          // into Cash Register (2026-09-01, sub-project 4).
          pendingCodTotal: Number(registerRes?.pendingCodTotal || 0),
          pendingCodDeliveries: Number(registerRes?.pendingCodDeliveries || 0),
        });
        const pendingList = pendingRes?.data?.sales || pendingRes?.data || [];
        const confirmedList = confirmedRes?.data?.sales || confirmedRes?.data || [];
        const preparingList = preparingRes?.data?.sales || preparingRes?.data || [];
        const readyList = readyRes?.data?.sales || readyRes?.data || [];
        setCounterPendingOrders([...pendingList, ...confirmedList, ...preparingList, ...readyList]);
        setTaskRows(Array.isArray(tasksRes?.data) ? tasksRes.data : []);
        setDoneTodayCount(Number(doneTodayRes?.data?.total || 0));
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Owner / Manager: full fetch ─────────────────────────
      const locationRes = await api.getLocations();
      const locationList = locationRes?.data?.locations || locationRes?.data || [];
      setLocations(Array.isArray(locationList) ? locationList : []);

      let locationId;
      if (locationScope === 'all' && isOwner) {
        locationId = null;
      } else if (locationScope != null) {
        locationId = locationScope;
      } else {
        locationId = activeLocation?.id || locationList?.[0]?.id || null;
      }
      // `filters` (with filter_date) drives the DATE-SCOPED widgets below —
      // Staff Today, Reports — which legitimately mean "today" or whatever
      // day dateScope is set to. It no longer drives the board's own sales
      // fetch (see boardFilters) — an owner/manager viewing the board got
      // ZERO cards whenever nothing was created or scheduled on that exact
      // date, even with dozens of open orders sitting at the location.
      // Live-reproduced 2026-09-03: 0 rows at BOTH locations tested, against
      // 26 (Main Shop) / 67 (Test Loc) real open orders. The board answers
      // "what needs doing", which isn't a function of when the order was
      // created — the counter_staff dashboard already fetches this way.
      const filters = locationId ? { location_id: locationId } : {};
      if (dateScope) {
        const pad = n => String(n).padStart(2, '0');
        filters.filter_date = `${dateScope.getFullYear()}-${pad(dateScope.getMonth() + 1)}-${pad(dateScope.getDate())}`;
      }
      const boardFilters = locationId ? { location_id: locationId } : {};

      const reqs = [
        api.getSales({ ...boardFilters, limit: 500 }),
        api.getProductionTasks({}),
      ];

      if (isOwnerOrManager) {
        reqs.push(api.getStaffToday(filters));
        reqs.push(api.getReportsDashboard(filters).catch(() => ({ data: null })));
      } else if (isStaff) {
        reqs.push(api.getMyTasks().catch(() => ({ data: [] })));
      }
      // "Done today" chip: literal today regardless of dateScope (the chip
      // says "today", not "the scoped day"), and independent of the now
      // date-unfiltered board fetch above — that fetch will include
      // completed orders from any day once the filter is gone, so counting
      // off it would no longer mean "today". One row is enough; GET /sales
      // computes an accurate `total` regardless of `limit`.
      const doneTodayIdx = reqs.length;
      reqs.push(
        api.getSales({ ...boardFilters, status: 'completed', filter_date: getShopTodayStr(DEFAULT_TZ), limit: 1 })
          .catch(() => ({ data: { total: 0 } }))
      );

      const results = await Promise.all(reqs);
      const salesRes = results[0];
      const tasksRes = results[1];
      const doneTodayRes = results[doneTodayIdx];

      const salesRows = salesRes?.data?.sales || salesRes?.data || [];
      const tasks = tasksRes?.data || [];

      setSales(Array.isArray(salesRows) ? salesRows.filter((s) => ORDER_TYPES.includes(s.order_type)) : []);
      setTaskRows(Array.isArray(tasks) ? tasks : []);
      setDoneTodayCount(Number(doneTodayRes?.data?.total || 0));

      if (isOwnerOrManager) {
        const staffRes = results[2];
        const reportsRes = results[3];

        const present = staffRes?.data?.present || [];
        const absent = staffRes?.data?.absent || [];

        const normalizedPresentRaw = present.map((s) => {
          let pulse = 'active';
          let pulseLabel = 'Active';
          const isActiveSession = typeof s.active_session === 'boolean' ? s.active_session : !s.clock_out;
          if (isActiveSession && (Number(s.outdoor_hours || 0) > 0 || s.status === 'half_day')) {
            pulse = 'busy';
            pulseLabel = 'Busy';
          } else if (!isActiveSession) {
            pulse = 'off';
            pulseLabel = 'Off-shift';
          }

          return {
            id: `present-${s.user_id || s.id}`,
            rawUserId: s.user_id || s.id,
            name: s.user_name,
            roleLabel: (s.user_role || '').replace('_', ' '),
            pulse,
            pulseLabel,
            detail: `${Number(s.sessions_count || 1)} session${Number(s.sessions_count || 1) > 1 ? 's' : ''}`,
          };
        });

        // Defensive dedupe by user id in case server/client data changes.
        const presentByUser = new Map();
        for (const p of normalizedPresentRaw) {
          const existing = presentByUser.get(p.rawUserId);
          if (!existing) {
            presentByUser.set(p.rawUserId, p);
            continue;
          }
          if (existing.pulse === 'off' && p.pulse !== 'off') {
            presentByUser.set(p.rawUserId, p);
          }
        }
        const normalizedPresent = Array.from(presentByUser.values());

        const normalizedAbsent = absent.map((s) => ({
          id: `absent-${s.id}`,
          name: s.name,
          roleLabel: (s.role || '').replace('_', ' '),
          pulse: 'off',
          pulseLabel: 'Off-shift',
        }));

        setStaffPulse([...normalizedPresent, ...normalizedAbsent].slice(0, 10));
        setReportKPIs(reportsRes?.data || null);
      } else {
        const myTasksRes = results[2];
        const myRows = myTasksRes?.data || [];
        setStaffPulse([
          {
            id: `self-${user?.id}`,
            name: user?.name || 'You',
            roleLabel: (role || '').replace('_', ' '),
            pulse: myRows.length > 0 ? 'busy' : 'active',
            pulseLabel: myRows.length > 0 ? 'Busy' : 'Active',
          },
        ]);
      }

      if (locationList.length > 0) {
        const registerCalls = await Promise.all(
          locationList.map(async (loc) => {
            try {
              const reg = await api.getRegisterStatus(loc.id);
              return {
                locationId: loc.id,
                locationName: loc.name,
                isOpen: reg?.isOpen === true,
                register: reg?.data || null,
                // getRegisterStatus() has returned these two fields all along
                // (the counter_staff/employee branches above already read them
                // off the same call) — this owner-facing map just never
                // extracted them, so RegisterCard had nothing to show even
                // after being given a COD row to render. Restored 2026-09-04.
                pendingCodTotal: Number(reg?.pendingCodTotal || 0),
                pendingCodDeliveries: Number(reg?.pendingCodDeliveries || 0),
              };
            } catch {
              return {
                locationId: loc.id,
                locationName: loc.name,
                isOpen: false,
                register: null,
              };
            }
          })
        );
        setRegisters(registerCalls);
      } else {
        setRegisters([]);
      }
    } catch (err) {
      showAlert('Dashboard', err?.message || 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeLocation?.id, isOwner, isOwnerOrManager, isStaff, isEmployee, isCounterStaff, isDeliveryPartner, isCustomer, locationScope, dateScope, role, user?.id, user?.name]);

  useEffect(() => {
    if (locationScope != null) return;
    if (activeLocation?.id) {
      setLocationScope(activeLocation.id);
      return;
    }
    if (locations.length > 0) {
      setLocationScope(locations[0].id);
    }
  }, [locationScope, activeLocation?.id, locations]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchDashboard();
    }, [fetchDashboard])
  );

  // The idle-lock screen is now an overlay on top of the still-mounted app
  // (see RootNavigator.js) rather than a real navigation away and back —
  // that's what stops an in-progress order from being wiped on lock, but
  // it also means this screen never loses React Navigation focus during a
  // lock, so useFocusEffect above never re-fires on unlock. Without this,
  // whatever was on screen when the lock triggered (register status,
  // "Need Attention" counts) just sat there stale after unlocking, with no
  // visual sign it wasn't current — reported live as the dashboard
  // "looking different" between login methods, actually a same-account
  // lock/unlock leaving old data on screen (2026-09-01).
  const wasLockedRef = useRef(false);
  useEffect(() => {
    if (wasLockedRef.current && !locked) {
      fetchDashboard();
    }
    wasLockedRef.current = locked;
  }, [locked, fetchDashboard]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboard();
  }, [fetchDashboard]);

  const tasksBySaleId = useMemo(() => {
    const map = new Map();
    for (const t of taskRows) {
      const arr = map.get(t.sale_id) || [];
      arr.push(t);
      map.set(t.sale_id, arr);
    }
    return map;
  }, [taskRows]);

  const advanceTaskStatus = useCallback(async (task) => {
    if (!task?.id) return;
    if (task.status === 'completed' || task.status === 'cancelled') return;

    setTaskActionLoading((prev) => ({ ...prev, [task.id]: true }));
    try {
      if (task.status === 'pending') {
        await api.pickTask(task.id);
      } else if (task.status === 'assigned') {
        await api.startTask(task.id);
      } else if (task.status === 'in_progress') {
        await api.completeTask(task.id);
      }
      setSelectedTaskModal(null);
      await fetchDashboard();
    } catch (err) {
      showAlert('Task Update', err?.message || 'Unable to update task status.');
    } finally {
      setTaskActionLoading((prev) => ({ ...prev, [task.id]: false }));
    }
  }, [fetchDashboard]);

  // Counter staff's per-order one-tap stage-advance now lives inside
  // OrderKanbanBoard itself (its own handleQuickAction, driven by the
  // server-computed `display_stage.nextAction` via api.advanceOrder) —
  // this screen-local version (pending -> preparing -> ready via
  // api.updateOrderStatus) was only ever used by the flat card list it
  // replaced (Task 11, order-lifecycle plan, 2026-09-01) and is gone with it.

  // Routing for a card whose display_stage.nextAction is null — the card
  // decides WHAT to offer (components/orderBoard/OrderCard.js resolveDeadEnd),
  // this decides WHERE it goes, because only the screen knows the navigator
  // layout. Spec §7.
  const handleResolveAction = useCallback(async (order, kind) => {
    if (kind === 'collect_payment') {
      const due = Number(order.grand_total || 0) - Number(order.total_paid || 0);
      navigation.navigate('POS', { screen: 'AddPayment', params: { saleId: order.id, due } });
      return;
    }
    // Picking a rider is one of the most repeated actions in the shop, so it
    // happens right here in a modal rather than costing a screen change plus
    // three more taps on DeliveryDetail (Task 14). DeliveryDetail is untouched
    // and still the home of everything else a delivery needs — reattempt,
    // cancel, convert-to-pickup, live tracking. This removes a detour, not a
    // screen. OrderCard only ever emits 'assign_rider' for a viewer whose role
    // can actually assign (its canManageDeliveries, mirroring
    // deliveries.js's authorize('owner','manager','counter_staff')), so by the
    // time this runs the role check has already passed — do not re-check or
    // relax it here.
    if (kind === 'assign_rider') {
      if (!order.delivery_id) {
        // A delivery order with no delivery row is a data problem, not a
        // dead end — send them to the order where they can see why.
        navigation.navigate('SaleDetail', { saleId: order.id });
        return;
      }
      const reqId = ++riderReqRef.current;
      setRiderPicker({ deliveryId: order.delivery_id, saleId: order.id, loading: true, people: [] });
      try {
        // Scope to the ORDER's own location, not the viewer's activeLocation:
        // an owner on "All locations" has no meaningful activeLocation, and a
        // delivery belongs to the shop that took it. Matches what
        // DeliveryDetailScreen already passes (delivery.location_id).
        const locId = order.location_id || activeLocation?.id;
        const res = await api.getDeliveryPartners(locId);
        let list = res?.data?.users || res?.data || [];
        if (!Array.isArray(list)) list = [];
        // The location filter is a convenience, not a rule — PUT
        // /deliveries/:id/assign accepts any active delivery_partner
        // regardless of location. Riders missing a user_locations row for this
        // shop come back as an empty list (verified live: location_id=2 and 3
        // return [] while three active riders exist), which would show
        // "Nobody is available right now" and dead-end the one action this
        // card exists to offer. So an empty scoped list retries unscoped.
        // ...but the fallback must never be SILENT. One shop today, more soon
        // (CLAUDE.md): the moment there are two, quietly widening the list means
        // someone hands an order to a rider standing in another shop with no
        // sign that is what happened. So we record that it happened and the
        // picker says so. Flagged true only when the wider call actually
        // produced riders — if it comes back empty too, the list is genuinely
        // empty and "showing everyone" would be a lie.
        let showingEveryone = false;
        if (list.length === 0 && locId) {
          const all = await api.getDeliveryPartners();
          const allList = all?.data?.users || all?.data || [];
          if (Array.isArray(allList) && allList.length > 0) {
            list = allList;
            showingEveryone = true;
          }
        }
        // Superseded while we were awaiting — the user cancelled, or opened a
        // different order's picker. Dropping the result is the whole point:
        // this setState rebuilds the object from THIS closure, deliveryId
        // included, so applying it late would silently repoint a picker
        // showing order B at order A's delivery and send the flowers to the
        // wrong address.
        if (riderReqRef.current !== reqId) return;
        setRiderPicker({
          deliveryId: order.delivery_id,
          saleId: order.id,
          loading: false,
          showingEveryone,
          people: list.map((p) => {
            // active_delivery_count comes back from pg as a STRING ("1", "7"),
            // so it needs Number() before any comparison. Shown so staff can
            // hand the next job to whoever is least loaded.
            const busy = Number(p.active_delivery_count || 0);
            return {
              id: p.id,
              name: p.name,
              meta: busy === 0 ? 'Free right now' : busy === 1 ? '1 on the road' : `${busy} on the road`,
            };
          }),
        });
      } catch (err) {
        // Same guard on the failure path: a stale error must not close a
        // picker the user has since reopened, nor alert about a request they
        // already walked away from.
        if (riderReqRef.current !== reqId) return;
        setRiderPicker(null);
        showAlert('Riders', err?.message || 'Could not load the rider list. Please try again.');
      }
      return;
    }
    // Who is making this? Same two-tap shape as the rider picker above, and
    // the same reason: assigning prep work is a constant action, and making it
    // cost a screen change is why nobody did it (Task 15).
    //
    // ONE kind covers two writes, because the card asks the same question in
    // two situations and the person is not asked to care which:
    //   'start'  — the card's Start Preparing action is still available, so
    //              picking someone rides along with it in one request
    //              (PUT /sales/:id/status, the only transition that acts on
    //              assigned_to at all).
    //   'assign' — the order is ALREADY preparing, so its nextAction is Mark
    //              Ready. Sending assigned_to there would both skip the order
    //              forward a stage AND assign nobody. This path therefore
    //              writes the tasks directly instead (PUT
    //              /production/tasks/:id/assign), touching no status.
    // OrderCard only emits this kind for owner/manager/counter_staff, which is
    // exactly that route's authorize() list — do not relax it here.
    if (kind === 'pick_preparer') {
      const nextAction = order.display_stage?.nextAction;
      const mode = nextAction?.body?.status === 'preparing' ? 'start' : 'assign';

      // This branch is entered from TWO places now — the card's primary action
      // and the order modal's copy of the same button (QuickModals.js) — so it
      // re-asks the shared rule rather than assuming the caller pre-filtered.
      // The card does pre-filter; the modal deliberately does not, which is how
      // it stops silently advancing with nobody attached.
      if (mode === 'start') {
        const step = resolvePreparerStep({
          order,
          tasks: tasksBySaleId.get(order.id),
          viewerRole: user?.role,
          viewerId: user?.id,
        });
        if (step.kind !== 'pick') {
          // 'advance' (nothing unassigned — asking would change nothing) or
          // 'self' (an employee takes it themselves). Either way: no prompt.
          try {
            await api.advanceOrder(nextAction, step.kind === 'self' ? { assigned_to: step.assignedTo } : undefined);
          } catch (err) {
            showAlert('Start Preparing', err?.message || 'Could not start this order. Please try again.');
            return;
          }
          await fetchDashboard();
          return;
        }
      }

      // Scope to the ORDER's own location for the same reason the rider picker
      // does: an owner on "All locations" has no meaningful activeLocation.
      const locId = order.location_id || activeLocation?.id;
      if (!locId) {
        // Defensive only — every sale carries a location. Send them somewhere
        // real rather than opening an empty picker.
        showAlert('Assign', 'Could not tell which shop this order belongs to. Open the order to assign someone.');
        navigation.navigate('SaleDetail', { saleId: order.id });
        return;
      }
      const reqId = ++preparerReqRef.current;
      setPreparerPicker({ order, mode, loading: true, people: [] });
      try {
        // GET /production/assignable-staff — not GET /users (the account
        // directory is owner/manager-only and far too broad for "who preps
        // this", CLAUDE.md) and no longer GET /auth/staff-roster, which Task 15
        // used and which measurement proved was the wrong list. The roster is
        // the UNAUTHENTICATED lock-screen list, so it filters
        // `employee_code IS NOT NULL` — correct there, because no code means no
        // PIN login — and returns no `role`. On live data that excluded all four
        // `employee` accounts, the exact people who do this shop's prep work,
        // while including the counter staff this picker is meant to leave out.
        // Widening the roster was rejected: it would break that screen's meaning
        // and widen what an unauthenticated caller can enumerate. The new
        // endpoint is authenticated and carries `role` (Task 17) — same
        // narrow-endpoint precedent as GET /deliveries/partners.
        //
        // It does NOT pre-filter. It returns everyone
        // PUT /production/tasks/:id/assign will accept — counter staff,
        // managers and the owner included — because that is the one thing the
        // server actually knows, and two screens want different subsets of it.
        // Each narrows to what belongs on its own screen: this picker to
        // PREP_ROLES, SaleDetailScreen's assign modal to ASSIGNABLE_STAFF_ROLES
        // (the same three roles it has always offered). So narrowing happens
        // HERE rather than via a query parameter, which would put this screen's
        // editorial choice into a shared contract and break the other caller.
        //
        // THIS picker asks the narrowest question of the three: counter staff
        // can hold a task, but they are not the ones making the bouquet, and
        // padding a list read at counter speed with names that are never the
        // answer is its own cost.
        //
        // Narrowing happens BEFORE the empty check below, not after. The other
        // order would be a silent dead end: at a location staffed only by
        // counter staff the scoped call returns people, so the fallback would
        // never fire, and the picker would render an empty list with no notice
        // explaining it.
        const onlyPrep = (rows) =>
          (Array.isArray(rows) ? rows : []).filter((p) => PREP_ROLES.includes(p.role));
        const res = await api.getAssignableStaff(locId);
        let list = onlyPrep(res?.staff);
        // Identical empty-scoped-list fallback to the rider picker above, for
        // the identical reason: the location filter is a convenience, not a
        // rule — PUT /production/tasks/:id/assign accepts any active staff
        // account regardless of location. Three of this shop's four live
        // `employee` accounts carry a user_locations row for one shop only, so
        // any other location comes back empty and would dead-end the one action
        // this card exists to offer. And as with riders, the widening is never
        // SILENT: one shop today, more soon (CLAUDE.md), and quietly listing
        // someone standing in a different shop is how prep work lands on the
        // wrong person with no sign that is what happened. Flagged true only
        // when the wider call actually produced people — if that comes back
        // empty too, the list is genuinely empty and "showing everyone" would
        // be a lie.
        let showingEveryone = false;
        if (list.length === 0 && locId) {
          const all = await api.getAssignableStaff();
          const allList = onlyPrep(all?.staff);
          if (allList.length > 0) {
            list = allList;
            showingEveryone = true;
          }
        }
        // Superseded while awaiting — cancelled, or a different order's picker
        // was opened. This setState rebuilds the object from THIS closure,
        // `order` included, so applying it late would leave the picker showing
        // one order and writing to another. Identical guard, identical reason,
        // to the rider branch above.
        if (preparerReqRef.current !== reqId) return;
        setPreparerPicker({
          order,
          mode,
          loading: false,
          showingEveryone,
          people: list.map((p) => ({
            id: p.id,
            name: p.name,
            // A real job title wins; the role is only the fallback, and only
            // ever in plain words (see STAFF_ROLE_LABELS).
            meta: p.job_title || STAFF_ROLE_LABELS[p.role] || null,
          })),
        });
      } catch (err) {
        // Same guard on the failure path: a stale error must not close a picker
        // the person has since reopened, nor talk to them about a request they
        // already walked away from.
        if (preparerReqRef.current !== reqId) return;
        setPreparerPicker(null);
        showAlert('Staff', err?.message || 'Could not load the staff list. Please try again.');
      }
      return;
    }
    // 'reattempt_delivery' still goes to DeliveryDetail — its Reattempt/Cancel
    // controls live there and there is no one-tap equivalent. OrderCard only
    // emits it for a viewer whose role can use them, so this never routes
    // anyone into a screen that will refuse them.
    if (kind === 'reattempt_delivery') {
      if (order.delivery_id) {
        navigation.navigate('DeliveryDetail', { deliveryId: order.delivery_id });
      } else {
        navigation.navigate('SaleDetail', { saleId: order.id });
      }
      return;
    }
    // Nothing to pick and nobody to choose: the open production tasks ARE the
    // blocker, and they live on the order. Deliberately the same destination
    // the card body already leads to — the button exists so the reason is
    // stated in words instead of relying on someone guessing that the whole
    // card is tappable (staff-ux-checklist #1: no hidden gestures). No role
    // check for the same reason: every viewer who can see this card can
    // already open the order by tapping it.
    if (kind === 'finish_tasks') {
      navigation.navigate('SaleDetail', { saleId: order.id });
      return;
    }
    if (kind === 'record_cod') {
      navigation.navigate('POS', { screen: 'Settlements' });
      return;
    }
    // OrderCard only emits this when resolveDeliverStep found real money
    // outstanding on a Mark Delivered nextAction it already knows this viewer
    // is allowed to fire (see that function) — so no role check here either,
    // same idiom as pick_preparer above. Opens filled in with the exact
    // outstanding amount; cash/upi mirrors PUT /deliveries/:id/deliver's own
    // validation (body('cod_method').isIn(['cash','upi'])).
    if (kind === 'collect_cod') {
      const outstanding = Number(order.cod_amount || 0) - Number(order.cod_collected || 0);
      setCodCollectPicker({
        order,
        amount: outstanding > 0 ? outstanding.toFixed(2) : '',
        method: 'cash',
        reference: '',
        loading: false,
      });
    }
  }, [navigation, activeLocation?.id, tasksBySaleId, user?.role, user?.id, fetchDashboard]);

  // Closing is also a cancellation: bumping the token orphans any in-flight
  // partner fetch or assign so it cannot resurrect the picker after the user
  // has deliberately dismissed it.
  const closeRiderPicker = useCallback(() => {
    riderReqRef.current += 1;
    setRiderPicker(null);
  }, []);

  // Second (and last) tap of the two-tap assign: pick a rider, write it,
  // refresh the board. The picker is put back into its loading state for the
  // duration so the rows are gone and a double-tap cannot fire two assigns.
  const handlePickRider = useCallback(async (person) => {
    const deliveryId = riderPicker?.deliveryId;
    if (!deliveryId || riderPicker?.loading) return;
    const reqId = ++riderReqRef.current;
    setRiderPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      await api.assignDelivery(deliveryId, { delivery_partner_id: person.id });
      // Only this interaction's own picker gets closed. If it was superseded,
      // whatever superseded it owns the UI now and must not be dismissed.
      if (riderReqRef.current === reqId) setRiderPicker(null);
      // Refreshed either way: the write DID land on the server, so the board
      // must show it regardless of what the user has since tapped.
      await fetchDashboard();
    } catch (err) {
      // Backend's own message, verbatim — it says the useful thing
      // ("Cannot assign delivery in delivered status", "Delivery partner not
      // found or inactive"). Picker closes first so the message is not stuck
      // behind a modal on web.
      if (riderReqRef.current !== reqId) return;
      setRiderPicker(null);
      showAlert('Assign Rider', err?.message || 'Could not assign this rider. Please try again.');
    }
  }, [riderPicker, fetchDashboard]);

  // The order modal's Start Preparing, routed into the identical flow as the
  // card's. It re-reads the order from `sales` rather than trusting the object
  // the modal was opened with, which can be a refresh behind.
  const handlePickPreparerFromModal = useCallback((order) => {
    if (!order?.id) return;
    const fresh = sales.find((s) => s.id === order.id)
      || counterPendingOrders.find((s) => s.id === order.id)
      || order;
    handleResolveAction(fresh, 'pick_preparer');
  }, [sales, counterPendingOrders, handleResolveAction]);

  // Same idea, for the order modal's Mark Delivered when COD is outstanding
  // (see QuickModals.js's confirmAction for why this exists at all — the
  // modal used to fire /deliver bare with no COD form, unlike the card).
  const handleCollectCodFromModal = useCallback((order) => {
    if (!order?.id) return;
    const fresh = sales.find((s) => s.id === order.id)
      || counterPendingOrders.find((s) => s.id === order.id)
      || order;
    handleResolveAction(fresh, 'collect_cod');
  }, [sales, counterPendingOrders, handleResolveAction]);

  // Closing is also a cancellation — same contract as closeRiderPicker.
  const closePreparerPicker = useCallback(() => {
    preparerReqRef.current += 1;
    setPreparerPicker(null);
  }, []);

  // Second tap of the who-is-making-this pick. Same loading-lock shape as
  // handlePickRider so a double-tap cannot fire two writes.
  const handlePickPreparer = useCallback(async (person) => {
    const picker = preparerPicker;
    if (!picker?.order || picker.loading) return;
    const reqId = ++preparerReqRef.current;
    setPreparerPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    let wrote = false;
    try {
      if (picker.mode === 'start') {
        const nextAction = picker.order.display_stage?.nextAction;
        if (!nextAction) throw new Error('This order has already moved on. Pull down to refresh.');
        await api.advanceOrder(nextAction, { assigned_to: person.id });
        wrote = true;
      } else {
        // Already preparing: name the owner of the work without touching the
        // order's status. One task per line item, so this is a handful of
        // requests at most. 'completed'/'cancelled' are skipped because the
        // route refuses them ("Cannot assign a finished task") — sending them
        // would fail the whole pick over work that is already done.
        const openTasks = (tasksBySaleId.get(picker.order.id) || []).filter(
          (t) => t.status !== 'completed' && t.status !== 'cancelled'
        );
        // ── Fill the free work first; never quietly take work off someone ──
        // When anything is unassigned, this fills ONLY that — the same set the
        // server's own `WHERE assigned_to IS NULL` would touch on the 'start'
        // path, so both modes of this one button mean the same thing. Only when
        // everything is already held does picking someone genuinely move the
        // work, and that is the case where the card says `change` rather than
        // `assign`. Reassigning a task another person is actively holding, one
        // at a time, stays on Sale Detail — one level deeper, not deleted.
        const free = openTasks.filter((t) => t.assigned_to == null);
        const targets = free.length > 0 ? free : openTasks;
        if (targets.length === 0) {
          throw new Error('There is no prep work left on this order to hand over.');
        }
        for (const t of targets) {
          // Re-checked INSIDE the loop, not just before it: a multi-item sale
          // issues several writes and the picker can be dismissed partway
          // through. Checking once at the top would leave the rest of the loop
          // running against a picker the person has already walked away from.
          if (preparerReqRef.current !== reqId) return;
          await api.assignTask(t.id, { assigned_to: person.id });
          wrote = true;
        }
      }
      // Only this interaction's own picker gets closed; if it was superseded,
      // whatever superseded it owns the UI now.
      if (preparerReqRef.current === reqId) setPreparerPicker(null);
      // Refreshed either way — the writes DID land, so the board must show them
      // regardless of what has been tapped since.
      await fetchDashboard();
    } catch (err) {
      if (preparerReqRef.current !== reqId) {
        // Superseded: say nothing, but still reconcile the board if a partial
        // write got out before the failure.
        if (wrote) { try { await fetchDashboard(); } catch (e) { /* stale board is recoverable */ } }
        return;
      }
      // Picker closes first so the message is not stuck behind a modal on web.
      setPreparerPicker(null);
      showAlert('Assign', err?.message || 'Could not assign this person. Please try again.');
      // A multi-task assign can fail halfway. Refresh so the card shows what
      // actually landed rather than what it looked like before the tap.
      if (wrote) { try { await fetchDashboard(); } catch (e) { /* see above */ } }
    }
  }, [preparerPicker, tasksBySaleId, fetchDashboard]);

  // "Leave for now" — start preparing without naming anybody. Assignment is
  // an improvement on the old flow, never a new gate in front of it: someone
  // mid-rush must always be able to move the order and sort out who is making
  // it afterwards (the card's "Nobody assigned yet · assign" line is exactly
  // that afterwards). Only offered in 'start' mode; in 'assign' mode there is
  // nothing to advance and Cancel already means "leave it".
  const handleLeavePreparerForNow = useCallback(async () => {
    const picker = preparerPicker;
    if (!picker?.order || picker.loading) return;
    const reqId = ++preparerReqRef.current;
    setPreparerPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      const nextAction = picker.order.display_stage?.nextAction;
      if (!nextAction) throw new Error('This order has already moved on. Pull down to refresh.');
      // No assigned_to key at all — NOT an empty string, which the route
      // parseInt()s into NaN and rejects with a 400.
      await api.advanceOrder(nextAction);
      if (preparerReqRef.current === reqId) setPreparerPicker(null);
      await fetchDashboard();
    } catch (err) {
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker(null);
      showAlert('Start Preparing', err?.message || 'Could not start this order. Please try again.');
    }
  }, [preparerPicker, fetchDashboard]);

  const closeCodCollectPicker = useCallback(() => setCodCollectPicker(null), []);

  // Refetch on close (not on every checkbox toggle inside the checklist) so
  // the card's "N/M" pill and completion color are current the moment the
  // modal is dismissed, without a request per tap while it's open.
  const closeLoadChecklist = useCallback(() => {
    setLoadChecklistOrder(null);
    fetchDashboard();
  }, [fetchDashboard]);

  // Submits Mark Delivered with the entered COD amount/method in one request —
  // same endpoint resolveDeliverStep found outstanding money on
  // (PUT /deliveries/:id/deliver), just no longer fired blind. Amount is
  // capped to what's actually outstanding so a typo can't overshoot into the
  // server's own "COD collection exceeds remaining amount" 400.
  const handleSubmitCodCollect = useCallback(async () => {
    const picker = codCollectPicker;
    if (!picker?.order || picker.loading) return;
    const nextAction = picker.order.display_stage?.nextAction;
    if (!nextAction) {
      setCodCollectPicker(null);
      showAlert('Mark Delivered', 'This order has already moved on. Pull down to refresh.');
      return;
    }
    const entered = parseFloat(picker.amount) || 0;
    const outstanding = Number(picker.order.cod_amount || 0) - Number(picker.order.cod_collected || 0);
    if (entered <= 0) {
      showAlert('Mark Delivered', 'Enter the amount collected, or the exact outstanding amount if paid in full.');
      return;
    }
    if (entered > outstanding + 0.01) {
      showAlert('Mark Delivered', `Only ₹${outstanding.toFixed(2)} is outstanding on this order.`);
      return;
    }
    setCodCollectPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      await api.advanceOrder(nextAction, {
        cod_collected: entered,
        cod_method: picker.method,
        cod_reference: picker.reference?.trim() || undefined,
      });
      setCodCollectPicker(null);
      await fetchDashboard();
    } catch (err) {
      setCodCollectPicker((prev) => (prev ? { ...prev, loading: false } : prev));
      showAlert('Mark Delivered', err?.message || 'Could not record this. Please try again.');
    }
  }, [codCollectPicker, fetchDashboard]);

  // Same destination screen, two different tabs: owner/manager reach Orders
  // Inbox via the `Orders` tab, counter staff via `EmployeeOrders`
  // (MainNavigator.js registers one or the other for a role, never both).
  // Hardcoding 'EmployeeOrders' would make either handler below a dead tap
  // for the owner — React Navigation drops a navigate to a route no
  // navigator in the tree owns, so nothing at all would happen.
  const ordersInboxTab = isOwnerOrManager ? 'Orders' : 'EmployeeOrders';

  // "Done today · N" chip — the only tap in this file that means "show me
  // completed orders", so it's the only one that should carry that filter.
  const handleNavigateToDone = useCallback(() => {
    navigation.navigate(ordersInboxTab, { screen: 'OrdersInbox', params: { status: 'completed' } });
  }, [navigation, ordersInboxTab]);

  // "N more — see all" on any Stage column (onShowAll, passed to every
  // column alike — see OrderKanbanBoard/StageColumn). This is a generic
  // overflow escape hatch, not specific to "done" — it used to share
  // handleNavigateToDone because both were unfiltered, but that handler now
  // hardcodes status=completed, which would silently mis-filter the "N
  // more" link on every other column (e.g. Preparing) to show completed
  // orders instead. Kept unfiltered here, matching pre-existing behaviour;
  // making this respect the column's own stage is a separate improvement,
  // not part of this fix.
  const handleShowAllOrders = useCallback(() => {
    navigation.navigate(ordersInboxTab, { screen: 'OrdersInbox' });
  }, [navigation, ordersInboxTab]);

  const activeOrderModalData = useMemo(() => {
    if (!selectedOrderModal) return null;
    const freshOrder = sales.find(s => s.id === selectedOrderModal.order.id) || selectedOrderModal.order;
    const freshTasks = tasksBySaleId.get(selectedOrderModal.order.id) || selectedOrderModal.tasks;
    return { order: freshOrder, tasks: freshTasks };
  }, [selectedOrderModal, sales, tasksBySaleId]);

  // Counter/employee register widget: open, but opened before today. Same
  // reasoning and treatment as CashRegisterScreen.js's hero card and the
  // owner's RegisterCard — see isRegisterStale's own comment. This is the
  // widget counter staff (the people who'd actually forget to close it)
  // look at every day, so it matters more here than anywhere else.
  const counterRegisterStale = !!counterStats.registerOpen && isRegisterStale({ opening_time: counterStats.registerOpenedAt });

  // Counter staff dashboard: split today/unscheduled orders from
  // future-scheduled ones — otherwise a delivery due in 5 days sits mixed
  // in with what actually needs attention right now (2026-08-31 fix).
  const counterOrdersSplit = useMemo(() => {
    const todayStr = getShopTodayStr(DEFAULT_TZ);
    return {
      dueToday: counterPendingOrders.filter((o) => !o.scheduled_date || o.scheduled_date <= todayStr),
      scheduledLater: counterPendingOrders.filter((o) => o.scheduled_date && o.scheduled_date > todayStr),
    };
  }, [counterPendingOrders]);

  // Same today/future split as counterOrdersSplit, applied to the owner/
  // manager board's own `sales` fetch. That fetch is deliberately
  // date-unfiltered now (see the comment above `boardFilters` — an
  // owner/manager viewing the board went to ZERO cards on any day nothing
  // was created/scheduled exactly then), which fixed that bug but
  // reintroduced the one this split exists to solve: a pre_order/delivery
  // scheduled days out sat mixed into "New" today, cluttering the board
  // with nothing actionable. This is a different axis than that fetch-time
  // date filter — it's the order's own scheduled_date, checked client-side
  // after the fetch — so restoring it here does not bring back the 0-cards
  // bug (2026-09-04).
  const ordersSplit = useMemo(() => {
    const todayStr = getShopTodayStr(DEFAULT_TZ);
    return {
      dueToday: sales.filter((o) => !o.scheduled_date || o.scheduled_date <= todayStr),
      scheduledLater: sales.filter((o) => o.scheduled_date && o.scheduled_date > todayStr),
    };
  }, [sales]);

  // Florist/employee task dashboard: same today/future split, applied to
  // the active (not completed/cancelled) task list (2026-08-31 fix).
  const myTasksSplit = useMemo(() => {
    const todayStr = getShopTodayStr(DEFAULT_TZ);
    const active = myTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
    return {
      dueToday: active.filter((t) => !t.scheduled_date || t.scheduled_date <= todayStr),
      scheduledLater: active.filter((t) => t.scheduled_date && t.scheduled_date > todayStr),
    };
  }, [myTasks]);

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
      >
        <View style={styles.heroCard}>
          <View style={[styles.rowBetween, { marginBottom: 4 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroEyebrow}>{isCustomer ? 'Your Account' : 'Operations Dashboard'}</Text>
              <Text style={styles.heroTitle}>Welcome, {(user?.name || 'Team').split(' ')[0]}</Text>
            </View>
            <View style={styles.heroIcon}>
              <Ionicons name="pulse" size={24} color="#fff" />
            </View>
          </View>
          <Text style={styles.heroSub}>
            {isCustomer ? 'Shop for flowers and track your orders'
              : isDeliveryPartner ? 'Your active deliveries and earnings at a glance'
              : isCounterStaff ? "Today's sales and orders at a glance"
              : isEmployee ? 'Your production tasks and work queue'
              : 'Real-time order flow, production pipeline, and operational health metrics'}
          </Text>
        </View>

        {/* Location & Date picker — owner/manager only */}
        {!isEmployee && !isCounterStaff && !isDeliveryPartner && !isCustomer && (locations.length > 0 || isOwnerOrManager) && (
          <View style={styles.scopeCard}>
            <View style={[styles.rowBetween, { marginBottom: 8 }]}>
              <Text style={styles.scopeLabel}>Dashboard Filter</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.primary + '15', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, gap: 4 }}
                onPress={() => setShowDatePicker(true)}
              >
                <Ionicons name="calendar" size={14} color={Colors.primary} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: Colors.primary }}>
                  {dateScope ? dateScope.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'All Time'}
                </Text>
                {dateScope && (
                  <TouchableOpacity onPress={() => setDateScope(null)} hitSlop={10} style={{ marginLeft: 4 }}>
                    <Ionicons name="close-circle" size={16} color={Colors.primary} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scopeChipsRow}>
              {isOwner && (
                <TouchableOpacity
                  style={[styles.scopeChip, locationScope === 'all' && styles.scopeChipActive]}
                  onPress={() => setLocationScope('all')}
                >
                  <Text style={[styles.scopeChipText, locationScope === 'all' && styles.scopeChipTextActive]}>All Locations</Text>
                </TouchableOpacity>
              )}
              {locations.map((loc) => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.scopeChip, locationScope === loc.id && styles.scopeChipActive]}
                  onPress={() => setLocationScope(loc.id)}
                >
                  <Text style={[styles.scopeChipText, locationScope === loc.id && styles.scopeChipTextActive]}>{loc.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.loadingText}>Loading dashboard...</Text>
          </View>
        ) : isDeliveryPartner ? (
          /* ═══ DELIVERY PARTNER DASHBOARD ═══ */
          <View style={{ gap: 12 }}>
            {/* Stats row */}
            <View style={styles.roleStatsRow}>
              <View style={[styles.roleStatCard, { borderLeftColor: '#0EA5E9' }]}>
                <Ionicons name="bicycle-outline" size={20} color="#0EA5E9" />
                <Text style={styles.roleStatCount}>{myDeliveries.filter(d => ['assigned','picked_up','in_transit'].includes(d.status)).length}</Text>
                <Text style={styles.roleStatLabel}>Active</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#F59E0B' }]}>
                <Ionicons name="time-outline" size={20} color="#F59E0B" />
                <Text style={styles.roleStatCount}>{myDeliveries.filter(d => d.status === 'pending').length}</Text>
                <Text style={styles.roleStatLabel}>Pending</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#10B981' }]}>
                <Ionicons name="wallet-outline" size={20} color="#10B981" />
                <Text style={styles.roleStatCount}>₹{reportKPIs?.unsettledTotal || 0}</Text>
                <Text style={styles.roleStatLabel}>Unsettled COD</Text>
              </View>
            </View>

            {/* Active deliveries */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Your Deliveries</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Deliveries')}>
                <Text style={{ color: Colors.primary, fontWeight: '600', fontSize: 13 }}>View All →</Text>
              </TouchableOpacity>
            </View>

            {myDeliveries.length === 0 ? (
              <View style={styles.roleEmptyCard}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#10B981" />
                <Text style={styles.roleEmptyTitle}>All clear!</Text>
                <Text style={styles.roleEmptyText}>No active deliveries right now.</Text>
              </View>
            ) : (
              myDeliveries.map((d) => {
                const statusColor = DELIVERY_STATUS_COLORS[d.status] || '#9CA3AF';
                const statusLabel = DELIVERY_STATUS_LABELS[d.status] || d.status;
                const orderStatus = ORDER_STATUS_LABELS[d.order_status] || (d.order_status ? d.order_status.toUpperCase() : 'Unknown');
                const orderStatusColor = d.order_status === 'ready' || d.order_status === 'completed' ? '#10B981' : '#F59E0B';
                
                let dateStr = 'No Date';
                if (d.scheduled_date) {
                   const [y, m, dayNum] = String(d.scheduled_date).split('-');
                   const dt = new Date(y, m - 1, dayNum);
                   dateStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                   if (d.scheduled_time) {
                     dateStr += `, ${formatTimeString(d.scheduled_time)}`;
                   }
                }

                return (
                  <TouchableOpacity
                    key={d.id}
                    style={[styles.roleTaskCard, { borderLeftColor: statusColor }]}
                    onPress={() => navigation.navigate('DeliveryDetail', { deliveryId: d.id })}
                    activeOpacity={0.8}
                  >
                    <View style={styles.roleTaskHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.roleTaskName} numberOfLines={1}>#{d.sale_number}</Text>
                        <Text style={[styles.roleTaskMeta, { color: '#0EA5E9', fontWeight: '700', marginTop: 0 }]}>
                          {dateStr}
                        </Text>
                      </View>
                      <View style={[styles.roleTaskBadge, { backgroundColor: statusColor + '20' }]}>
                        <Text style={[styles.roleTaskBadgeText, { color: statusColor }]}>{statusLabel.toUpperCase()}</Text>
                      </View>
                    </View>

                    <Text style={[styles.roleTaskMeta, { marginBottom: 6 }]} numberOfLines={2}>
                      <Ionicons name="location-outline" size={12} color="#9CA3AF" /> {d.delivery_address || 'No address'}
                    </Text>
                    
                    {d.special_instructions && (
                      <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, marginBottom: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: '500', color: '#B45309' }}>⚡ {d.special_instructions}</Text>
                      </View>
                    )}

                    {d.items && d.items.length > 0 && (
                      <View style={{ backgroundColor: '#F9FAFB', padding: 8, borderRadius: 6, marginBottom: 8, borderWidth: 1, borderColor: '#F3F4F6' }}>
                        {d.items.map((item, idx) => (
                          <Text key={idx} style={{ fontSize: 12, color: '#4B5563', marginBottom: idx === d.items.length - 1 ? 0 : 2 }}>
                            {Number(item.quantity || 1)}× {item.product_name}
                          </Text>
                        ))}
                      </View>
                    )}

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="cube-outline" size={14} color={orderStatusColor} />
                        <Text style={[styles.roleTaskMeta, { color: orderStatusColor, fontWeight: '600', marginTop: 0 }]}>
                          Order: {orderStatus}
                        </Text>
                      </View>
                      {d.payment_status === 'paid' ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="checkmark-circle" size={14} color="#10B981" />
                          <Text style={[styles.roleTaskMeta, { color: '#10B981', fontWeight: '700', marginTop: 0 }]}>PAID</Text>
                        </View>
                      ) : d.is_credit_sale === 1 ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="document-text" size={14} color="#8B5CF6" />
                          <Text style={[styles.roleTaskMeta, { color: '#8B5CF6', fontWeight: '700', marginTop: 0 }]}>CREDIT</Text>
                        </View>
                      ) : (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="warning" size={14} color="#EF4444" />
                          <Text style={[styles.roleTaskMeta, { color: '#EF4444', fontWeight: '700', marginTop: 0 }]}>UNPAID</Text>
                        </View>
                      )}
                    </View>

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F3F4F6' }}>
                      <View>
                        <Text style={[styles.roleTaskMeta, { color: '#111827', fontWeight: '600' }]}>{d.customer_name || 'Customer'}</Text>
                        {d.customer_phone ? (
                          <TouchableOpacity onPress={() => Linking.openURL(`tel:${d.customer_phone}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Ionicons name="call" size={12} color={Colors.primary} />
                            <Text style={[styles.roleTaskMeta, { color: Colors.primary, marginTop: 0 }]}>{d.customer_phone}</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      {Number(d.cod_amount) > 0 && (
                        <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignItems: 'center' }}>
                          <Text style={{ fontSize: 10, color: '#92400E', fontWeight: '600', textTransform: 'uppercase' }}>To Collect</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: '#B45309' }}>₹{Number(d.cod_amount).toFixed(0)}</Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        ) : isCounterStaff ? (
          /* ═══ COUNTER STAFF DASHBOARD ═══
             Counts and status only — no revenue totals or exact cash
             amounts (owner/manager territory). See discussion 2026-08-31. */
          <View style={{ gap: 12 }}>
            <View style={styles.roleStatsRow}>
              <View style={[styles.roleStatCard, { borderLeftColor: '#0EA5E9' }]}>
                <Ionicons name="receipt-outline" size={20} color="#0EA5E9" />
                <Text style={styles.roleStatCount}>{counterStats.salesCount}</Text>
                <Text style={styles.roleStatLabel}>Sales Today</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#F59E0B' }]}>
                <Ionicons name="alert-circle-outline" size={20} color="#F59E0B" />
                <Text style={styles.roleStatCount}>{counterOrdersSplit.dueToday.length}</Text>
                <Text style={styles.roleStatLabel}>Need Attention</Text>
              </View>
              {/* This card is the ONLY way in for counter staff once the
                  register is already open — the "isn't open" banner below
                  and the reactive alert on Checkout/Log Order both only
                  fire while it's closed, so there was previously no path
                  at all to reach CashRegisterScreen to close it at end of
                  shift (found live, 2026-09-01). Always tappable now. */}
              <TouchableOpacity
                style={[styles.roleStatCard, { borderLeftColor: counterStats.registerOpen ? (counterRegisterStale ? '#D97706' : '#10B981') : '#EF4444' }]}
                onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}
              >
                <Ionicons name={counterStats.registerOpen ? 'lock-open-outline' : 'lock-closed-outline'} size={20} color={counterStats.registerOpen ? (counterRegisterStale ? '#D97706' : '#10B981') : '#EF4444'} />
                <Text style={[styles.roleStatCount, { fontSize: 14 }]}>{counterStats.registerOpen === null ? '—' : counterStats.registerOpen ? 'Open' : 'Closed'}</Text>
                <Text style={styles.roleStatLabel}>Register</Text>
              </TouchableOpacity>
            </View>

            {counterRegisterStale && (
              <TouchableOpacity style={styles.codBannerCompact} onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}>
                <Ionicons name="time-outline" size={20} color="#92400E" />
                <Text style={styles.codBannerCompactText}>
                  Register open since {formatDateLabel(counterStats.registerOpenedAt)} — close it out when you get a chance
                </Text>
                <Ionicons name="chevron-forward" size={16} color="#92400E" />
              </TouchableOpacity>
            )}

            {!counterStats.registerOpen && counterStats.registerOpen !== null && (
              <TouchableOpacity style={styles.roleEmptyCard} onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}>
                <Ionicons name="lock-closed-outline" size={32} color="#EF4444" />
                <Text style={styles.roleEmptyTitle}>Register isn't open</Text>
                <Text style={styles.roleEmptyText}>Tap here to open it before taking a cash sale.</Text>
              </TouchableOpacity>
            )}

            {/* Money a delivery partner has collected but hasn't handed
                over yet — was owner/manager-only visibility buried inside
                Cash Register; surfaced here directly since counter staff
                are the ones who actually take this handoff and settle it
                (2026-09-01, sub-project 4). */}
            {counterStats.pendingCodTotal > 0 && (
              <TouchableOpacity style={styles.codBannerCompact} onPress={() => navigation.navigate('POS', { screen: 'Settlements' })}>
                <Ionicons name="alert-circle" size={20} color="#92400E" />
                <Text style={styles.codBannerCompactText}>
                  ₹{counterStats.pendingCodTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })} from {counterStats.pendingCodDeliveries} deliver{counterStats.pendingCodDeliveries !== 1 ? 'ies' : 'y'} not settled yet
                </Text>
                <Ionicons name="chevron-forward" size={16} color="#92400E" />
              </TouchableOpacity>
            )}

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Orders Needing Attention</Text>
              <TouchableOpacity onPress={() => navigation.navigate('EmployeeOrders', { screen: 'OrdersInbox' })}>
                <Text style={{ color: Colors.primary, fontWeight: '600', fontSize: 13 }}>Orders Inbox →</Text>
              </TouchableOpacity>
            </View>

            {counterOrdersSplit.dueToday.length === 0 ? (
              <View style={styles.roleEmptyCard}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#10B981" />
                <Text style={styles.roleEmptyTitle}>All caught up!</Text>
                <Text style={styles.roleEmptyText}>
                  {counterOrdersSplit.scheduledLater.length > 0
                    ? `No orders waiting on you right now — ${counterOrdersSplit.scheduledLater.length} scheduled for later.`
                    : 'No orders waiting on you right now.'}
                </Text>
              </View>
            ) : (
              <>
                {/* Rebuilt onto the same order-kanban board owner/manager uses
                    (Task 11, order-lifecycle plan, 2026-09-01) — grouped by
                    order type + status lane with inline one-tap stage-advance
                    and production-task pills, matching the explicit brainstorm
                    ask: "a mix of both, the current manager dashboard and the
                    current counter dashboard... grouping and viewing and
                    updating in a single quick way." Fed `counterOrdersSplit.dueToday`
                    (not the full counterPendingOrders fetch) to keep the
                    existing today/future split intent intact — a delivery
                    scheduled days out still shouldn't clutter what needs
                    attention right now; see the note below for the rest. */}
                <OrderKanbanBoard
                  sales={counterOrdersSplit.dueToday}
                  onOrderPress={(order) => setSelectedOrderModal({ order, tasks: tasksBySaleId.get(order.id) })}
                  onResolveAction={handleResolveAction}
                  onVerifyLoad={(order) => setLoadChecklistOrder(order)}
                  onNavigateToDone={handleNavigateToDone}
                  onShowAll={handleShowAllOrders}
                  tasksBySaleId={tasksBySaleId}
                  timezone={timezone}
                  viewerRole={user?.role}
                  viewerId={user?.id}
                  onRefresh={fetchDashboard}
                  doneCountOverride={doneTodayCount}
                />
                {counterOrdersSplit.scheduledLater.length > 0 && (
                  <TouchableOpacity onPress={handleShowAllOrders} activeOpacity={0.7}>
                    <Text style={{ fontSize: 12, color: '#6B7280', textAlign: 'center', marginTop: 4, textDecorationLine: 'underline' }}>
                      +{counterOrdersSplit.scheduledLater.length} more scheduled for later
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        ) : isEmployee ? (
          /* ═══ EMPLOYEE DASHBOARD ═══ */
          <View style={{ gap: 12 }}>
            {/* Stats row */}
            <View style={styles.roleStatsRow}>
              <View style={[styles.roleStatCard, { borderLeftColor: '#F59E0B' }]}>
                <Ionicons name="hourglass-outline" size={20} color="#F59E0B" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'assigned').length}</Text>
                <Text style={styles.roleStatLabel}>Assigned</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#0EA5E9' }]}>
                <Ionicons name="construct-outline" size={20} color="#0EA5E9" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'in_progress').length}</Text>
                <Text style={styles.roleStatLabel}>In Progress</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#10B981' }]}>
                <Ionicons name="checkmark-done-outline" size={20} color="#10B981" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'completed').length}</Text>
                <Text style={styles.roleStatLabel}>Done Today</Text>
              </View>
              {/* florist_staff never takes payments (no POS tab, see
                  FloristStack) so it has no reason to see or manage the
                  register — this card is employee-only, same reasoning
                  as the counter_staff fix above. */}
              {role === 'employee' && (
                <TouchableOpacity
                  style={[styles.roleStatCard, { borderLeftColor: counterStats.registerOpen ? (counterRegisterStale ? '#D97706' : '#10B981') : '#EF4444' }]}
                  onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}
                >
                  <Ionicons name={counterStats.registerOpen ? 'lock-open-outline' : 'lock-closed-outline'} size={20} color={counterStats.registerOpen ? (counterRegisterStale ? '#D97706' : '#10B981') : '#EF4444'} />
                  <Text style={[styles.roleStatCount, { fontSize: 14 }]}>{counterStats.registerOpen === null ? '—' : counterStats.registerOpen ? 'Open' : 'Closed'}</Text>
                  <Text style={styles.roleStatLabel}>Register</Text>
                </TouchableOpacity>
              )}
            </View>

            {role === 'employee' && counterRegisterStale && (
              <TouchableOpacity style={styles.codBannerCompact} onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}>
                <Ionicons name="time-outline" size={20} color="#92400E" />
                <Text style={styles.codBannerCompactText}>
                  Register open since {formatDateLabel(counterStats.registerOpenedAt)} — close it out when you get a chance
                </Text>
                <Ionicons name="chevron-forward" size={16} color="#92400E" />
              </TouchableOpacity>
            )}

            {role === 'employee' && !counterStats.registerOpen && counterStats.registerOpen !== null && (
              <TouchableOpacity style={styles.roleEmptyCard} onPress={() => navigation.navigate('POS', { screen: 'CashRegister' })}>
                <Ionicons name="lock-closed-outline" size={32} color="#EF4444" />
                <Text style={styles.roleEmptyTitle}>Register isn't open</Text>
                <Text style={styles.roleEmptyText}>Tap here to open it before taking a cash sale.</Text>
              </TouchableOpacity>
            )}

            {role === 'employee' && counterStats.pendingCodTotal > 0 && (
              <TouchableOpacity style={styles.codBannerCompact} onPress={() => navigation.navigate('POS', { screen: 'Settlements' })}>
                <Ionicons name="alert-circle" size={20} color="#92400E" />
                <Text style={styles.codBannerCompactText}>
                  ₹{counterStats.pendingCodTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })} from {counterStats.pendingCodDeliveries} deliver{counterStats.pendingCodDeliveries !== 1 ? 'ies' : 'y'} not settled yet
                </Text>
                <Ionicons name="chevron-forward" size={16} color="#92400E" />
              </TouchableOpacity>
            )}

            {/* My assigned tasks */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>My Tasks</Text>
              <TouchableOpacity onPress={() => navigation.navigate('ProductionQueue')}>
                <Text style={{ color: Colors.primary, fontWeight: '600', fontSize: 13 }}>Full Queue →</Text>
              </TouchableOpacity>
            </View>

            {myTasksSplit.dueToday.length === 0 ? (
              <View style={styles.roleEmptyCard}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#10B981" />
                <Text style={styles.roleEmptyTitle}>All caught up!</Text>
                <Text style={styles.roleEmptyText}>
                  {myTasksSplit.scheduledLater.length > 0
                    ? `No pending tasks for today — ${myTasksSplit.scheduledLater.length} scheduled for later.`
                    : 'No pending tasks assigned to you.'}
                </Text>
              </View>
            ) : (
              myTasksSplit.dueToday
                .map((task) => {
                  const tColor = getTaskChipColor(task.status);
                  const tLabel = TASK_STATUS_LABELS[task.status] || task.status;
                  const isTaskLoading = !!taskActionLoading[task.id];
                  
                  const isUrgent = task.priority === 'urgent';
                  const notes = task.item_special_instructions || task.order_special_instructions || task.special_instructions;
                  
                  let deadlineStr = null;
                  if (task.scheduled_date) {
                    const [y, m, dayNum] = String(task.scheduled_date).split('-');
                    const dt = new Date(y, m - 1, dayNum);
                    deadlineStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                    if (task.scheduled_time) deadlineStr += `, ${formatTimeString(task.scheduled_time)}`;
                  }

                  const imageUri = task.product_image || task.item_image_url;

                  return (
                    <TouchableOpacity
                      key={task.id}
                      style={[styles.roleTaskCard, { borderLeftColor: isUrgent ? '#EF4444' : tColor }]}
                      onPress={() => setSelectedTaskModal(task)}
                      activeOpacity={0.8}
                    >
                      <View style={{ flexDirection: 'row', gap: 12 }}>
                        {imageUri ? (
                          <TouchableOpacity onPress={(e) => { e.stopPropagation(); setViewedImage(api.getMediaUrl(imageUri)); }}>
                            <Image source={{ uri: api.getMediaUrl(imageUri) }} style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: '#F3F4F6' }} />
                          </TouchableOpacity>
                        ) : (
                          <View style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="image-outline" size={24} color="#D1D5DB" />
                          </View>
                        )}
                        
                        <View style={{ flex: 1 }}>
                          <View style={styles.roleTaskHeader}>
                            <Text style={styles.roleTaskName} numberOfLines={2}>
                              {Number(task.quantity || 1)}× {task.product_name || task.item_product_name || 'Task'}
                            </Text>
                            <View style={[styles.roleTaskBadge, { backgroundColor: (isUrgent ? '#EF4444' : tColor) + '20' }]}>
                              <Text style={[styles.roleTaskBadgeText, { color: isUrgent ? '#EF4444' : tColor }]}>
                                {isUrgent ? 'URGENT' : tLabel}
                              </Text>
                            </View>
                          </View>
                          
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                            {task.sale_number && <Text style={[styles.roleTaskMeta, { color: '#4B5563', fontWeight: '600' }]}>Order #{task.sale_number}</Text>}
                            {deadlineStr && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Ionicons name="time-outline" size={12} color={isUrgent ? '#EF4444' : '#6B7280'} />
                                <Text style={[styles.roleTaskMeta, { marginTop: 0, color: isUrgent ? '#EF4444' : '#6B7280', fontWeight: isUrgent ? '700' : '500' }]}>
                                  Due: {deadlineStr}
                                </Text>
                              </View>
                            )}
                          </View>
                        </View>
                      </View>

                      {notes && (
                        <View style={{ marginTop: 10, backgroundColor: '#FEF3C7', padding: 8, borderRadius: 6 }}>
                          <Text style={{ color: '#B45309', fontSize: 12, fontWeight: '500' }}>⚡ {notes}</Text>
                        </View>
                      )}

                      {/* What to grab — recipe/custom materials with live stock,
                          so prep staff don't need to leave the dashboard to check.
                          Insufficient stock highlighted in red. */}
                      {task.materials && task.materials.length > 0 && (
                        <View style={{ marginTop: 10 }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#6B7280', marginBottom: 4, textTransform: 'uppercase' }}>Materials</Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {task.materials.map((m, idx) => (
                              <View
                                key={m.material_id || idx}
                                style={{
                                  paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12,
                                  backgroundColor: m.sufficient === false ? '#FEE2E2' : '#F3F4F6',
                                }}
                              >
                                <Text style={{ fontSize: 11, fontWeight: '600', color: m.sufficient === false ? '#EF4444' : '#4B5563' }}>
                                  {Number(m.total_needed || m.qty_per_unit || 1)}× {m.material_name}
                                </Text>
                              </View>
                            ))}
                          </View>
                        </View>
                      )}

                      {/* Voice note(s) the customer/staff left on this order —
                          play inline, no need to open the full order detail. */}
                      {task.voice_notes && task.voice_notes.length > 0 && (
                        <View style={{ marginTop: 10 }}>
                          {task.voice_notes.map((vn) => (
                            <AttachmentVoiceRow key={vn.id} attachment={vn} />
                          ))}
                        </View>
                      )}

                      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 10 }}>
                        {task.status === 'assigned' && (
                          <TouchableOpacity
                            style={[styles.roleActionBtn, { backgroundColor: '#0EA5E9' }]}
                            onPress={() => advanceTaskStatus(task)}
                            disabled={isTaskLoading}
                          >
                            {isTaskLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                              <Text style={styles.roleActionBtnText}>Start Working →</Text>
                            )}
                          </TouchableOpacity>
                        )}
                        {task.status === 'in_progress' && (
                          <TouchableOpacity
                            style={[styles.roleActionBtn, { backgroundColor: '#10B981' }]}
                            onPress={() => advanceTaskStatus(task)}
                            disabled={isTaskLoading}
                          >
                            {isTaskLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                              <Text style={styles.roleActionBtnText}>Complete Task ✓</Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })
            )}
            {myTasksSplit.dueToday.length > 0 && myTasksSplit.scheduledLater.length > 0 && (
              <Text style={{ fontSize: 12, color: '#6B7280', textAlign: 'center', marginTop: 4 }}>
                +{myTasksSplit.scheduledLater.length} more scheduled for later
              </Text>
            )}

            {/* Completed today */}
            {myTasks.filter(t => t.status === 'completed').length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: '#10B981' }]}>Completed Today</Text>
                </View>
                {myTasks.filter(t => t.status === 'completed').slice(0, 5).map((task) => (
                  <View key={task.id} style={[styles.roleTaskCard, { borderLeftColor: '#10B981', opacity: 0.7 }]}>
                    <View style={styles.roleTaskHeader}>
                      <Text style={[styles.roleTaskName, { textDecorationLine: 'line-through' }]} numberOfLines={1}>
                        {Number(task.quantity || 1)}× {task.product_name || task.item_product_name || 'Task'}
                      </Text>
                      <Ionicons name="checkmark-circle" size={18} color="#10B981" />
                    </View>
                    {task.sale_number && <Text style={styles.roleTaskMeta}>Order #{task.sale_number}</Text>}
                  </View>
                ))}
              </>
            )}
          </View>
        ) : isCustomer ? (
          /* ═══ CUSTOMER ═══
             Must stay ahead of the owner/manager fall-through below: without
             this branch a customer landed on the operations dashboard itself
             (order board, revenue, registers, staff). Nothing here is shop
             data — just the two places a customer actually has. */
          <View style={{ gap: 12 }}>
            <View style={styles.customerCard}>
              <Ionicons name="flower-outline" size={40} color={Colors.primary} />
              <Text style={styles.customerCardTitle}>Welcome to the shop</Text>
              <Text style={styles.customerCardText}>
                Browse what's in stock, or check on an order you've already placed.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.customerBtn}
              onPress={() => navigation.navigate('Shop')}
              activeOpacity={0.85}
            >
              <Ionicons name="storefront-outline" size={22} color="#fff" />
              <Text style={styles.customerBtnText}>Browse Flowers</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.customerBtnSecondary}
              onPress={() => navigation.navigate('MyOrders')}
              activeOpacity={0.85}
            >
              <Ionicons name="receipt-outline" size={22} color={Colors.primary} />
              <Text style={styles.customerBtnSecondaryText}>My Orders</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* ═══ OWNER / MANAGER DASHBOARD ═══ */
          /* Board gets the full width on every screen size — Team & Finance
             moves BELOW it rather than squeezing it into 2/3 width, per the
             owner's direct request (2026-09-04). Was a row-on-desktop split
             (feedCol flex:2 / healthCol flex:1); the "1/3 width" complaint
             was structural for anyone who isn't `owner`, since a manager
             only ever sees Staff Pulse there — Registers and Revenue are
             owner-only — so a manager lost a third of the page's width to
             one small widget. `layoutDesktop`/the flex overrides are gone;
             `layout`'s plain `{ gap: 16 }` already stacks correctly. */
          <View style={styles.layout}>
            <View style={styles.feedCol}>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>Order Management</Text>
                  <Text style={styles.sectionSubtitle}>Tap an order to see details, or use its button to move it forward</Text>
                </View>
              </View>

              <View style={{ gap: 12 }}>
                <OrderKanbanBoard
                  sales={ordersSplit.dueToday}
                  onOrderPress={(order) => setSelectedOrderModal({ order, tasks: tasksBySaleId.get(order.id) })}
                  onResolveAction={handleResolveAction}
                  onVerifyLoad={(order) => setLoadChecklistOrder(order)}
                  onNavigateToDone={handleNavigateToDone}
                  onShowAll={handleShowAllOrders}
                  tasksBySaleId={tasksBySaleId}
                  timezone={timezone}
                  viewerRole={user?.role}
                  viewerId={user?.id}
                  onRefresh={fetchDashboard}
                  doneCountOverride={doneTodayCount}
                />
                {ordersSplit.scheduledLater.length > 0 && (
                  <TouchableOpacity onPress={handleShowAllOrders} activeOpacity={0.7}>
                    <Text style={{ fontSize: 12, color: '#6B7280', textAlign: 'center' }}>
                      +{ordersSplit.scheduledLater.length} more scheduled for later
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <View style={styles.healthCol}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Team & Finance</Text>
              </View>

              {/* The three widget groups below sit in a row on wide screens
                  (isDesktop, 1100px — the same threshold the board itself no
                  longer needs but this section still benefits from) and stack
                  on narrow ones. Full-width real estate is now available here
                  precisely because the board above stopped needing to share
                  it, so laying these out side by side uses it rather than
                  leaving it as the same cramped single column, just moved. */}
              <View style={[styles.healthRow, isDesktop && styles.healthRowDesktop]}>
                {/* Staff Pulse Widget */}
                <View style={[styles.healthGroup, isDesktop && styles.healthGroupDesktop]}>
                  <View style={styles.widgetCard}>
                    <View style={styles.widgetHeader}>
                      <Text style={styles.widgetTitle}>Staff Pulse</Text>
                      <TouchableOpacity onPress={() => isOwnerOrManager ? navigation.navigate('More', { screen: 'Staff', initial: false }) : null}>
                        <Ionicons name="open" size={14} color="#9CA3AF" />
                      </TouchableOpacity>
                    </View>

                    {staffPulse.length === 0 ? (
                      <Text style={styles.emptyWidgetText}>No staff data</Text>
                    ) : (
                      <View style={{ gap: 6 }}>
                        {staffPulse.map((s) => <StaffPulseRow key={s.id} staff={s} />)}
                      </View>
                    )}
                  </View>
                </View>

                {/* Cash Register Widget */}
                {isOwner && (
                  <View style={[styles.healthGroup, isDesktop && styles.healthGroupDesktop]}>
                    <View style={styles.sectionHeader}>
                      <Text style={styles.sectionTitle}>Registers</Text>
                    </View>

                    <View style={{ gap: 8 }}>
                      {registers.length === 0 ? (
                        <View style={styles.widgetCard}>
                          <Text style={styles.emptyWidgetText}>No register data</Text>
                        </View>
                      ) : (
                        registers.map((r) => (
                          <RegisterCard
                            key={r.locationId}
                            item={r}
                            onPress={() => navigation.navigate('POS', {
                              screen: 'CashRegister',
                              params: { locationId: r.locationId }
                            })}
                            onSettlePress={() => navigation.navigate('POS', {
                              screen: 'Settlements',
                              params: { locationId: r.locationId }
                            })}
                          />
                        ))
                      )}
                    </View>
                  </View>
                )}

                {/* Revenue Snapshot */}
                {isOwner && reportKPIs && (
                  <View style={[styles.healthGroup, isDesktop && styles.healthGroupDesktop]}>
                    <View style={styles.sectionHeader}>
                      <Text style={styles.sectionTitle}>Revenue</Text>
                    </View>
                    <View style={styles.widgetCard}>
                      <View style={styles.revenueStat}>
                        <Text style={styles.revenueLabel}>Today</Text>
                        <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.today?.revenue)}</Text>
                      </View>
                      <View style={[styles.divider, { marginVertical: 10 }]} />
                      <View style={[styles.rowBetween, { marginBottom: 8 }]}>
                        <View style={styles.revenueStat}>
                          <Text style={styles.revenueLabel}>Yesterday</Text>
                          <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.yesterday?.revenue)}</Text>
                        </View>
                        <View style={styles.revenueStat}>
                          <Text style={styles.revenueLabel}>Week</Text>
                          <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.week?.revenue)}</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Owner/manager only — counter staff has their own Log Order FAB on
          Orders Inbox, and florist_staff has no page this quick-add modal
          could send them to (they were previously seeing this button with
          nowhere it could actually take them — 2026-08-31 fix). */}
      {isOwnerOrManager && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setFabVisible(true)}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={28} color="#fff" />
        </TouchableOpacity>
      )}

      <ImageModal visible={!!viewedImage} imageUrl={viewedImage} onClose={() => setViewedImage(null)} />

      <DateTimePickerModal
        visible={showDatePicker}
        mode="date"
        value={dateScope || new Date()}
        onConfirm={(d) => { setDateScope(d); setShowDatePicker(false); }}
        onCancel={() => setShowDatePicker(false)}
        title="Select Dashboard Date"
      />

      <TaskDetailModal
        visible={selectedTaskModal !== null}
        task={selectedTaskModal}
        onClose={() => setSelectedTaskModal(null)}
        onAdvance={advanceTaskStatus}
        loading={selectedTaskModal && taskActionLoading[selectedTaskModal.id]}
      />

      <OrderQuickModal
        visible={activeOrderModalData !== null}
        order={activeOrderModalData?.order || null}
        tasks={activeOrderModalData?.tasks || []}
        onClose={() => setSelectedOrderModal(null)}
        onRefresh={fetchDashboard}
        navigation={navigation}
        canManage={isOwnerOrManager}
        // Same flow the card's Start Preparing uses, so which part of the card
        // someone happened to tap cannot change what the button does.
        onPickPreparer={handlePickPreparerFromModal}
        onCollectCod={handleCollectCodFromModal}
      />

      {/* Two-tap assign: "Assign Rider" on the card opens this, one tap on a
          name writes it. Rendered once here (not inside OrderKanbanBoard,
          which this screen mounts in two different branches) so there is only
          ever one picker in the tree. */}
      <AssignPickerModal
        visible={riderPicker !== null}
        title="Who is delivering this?"
        notice={riderPicker?.showingEveryone
          ? 'No riders are set up for this location — showing everyone.'
          : null}
        people={riderPicker?.people || []}
        loading={!!riderPicker?.loading}
        onPick={handlePickRider}
        onClose={closeRiderPicker}
        footer={
          // Never a dead end: with no rider to pick, the only thing left to do
          // with this order lives on Delivery Detail (reattempt, cancel,
          // convert to pickup). Only shown when there is genuinely nothing to
          // tap above — the normal path never sees it.
          !riderPicker?.loading && (riderPicker?.people || []).length === 0 && riderPicker?.deliveryId ? (
            <TouchableOpacity
              style={styles.pickerFallbackBtn}
              activeOpacity={0.7}
              onPress={() => {
                const deliveryId = riderPicker.deliveryId;
                closeRiderPicker();
                navigation.navigate('DeliveryDetail', { deliveryId });
              }}
            >
              <Text style={styles.pickerFallbackText}>Open Delivery Details</Text>
            </TouchableOpacity>
          ) : null
        }
      />

      {/* Who is making this (Task 15). A separate instance rather than a mode
          flag on the rider picker above: the two answer different questions,
          write to different endpoints, and are never open at the same time, so
          sharing one would only make each branch harder to read. Same reason
          both live here and not inside OrderKanbanBoard — this screen mounts
          that board in two branches, and one picker in the tree is enough. */}
      <AssignPickerModal
        visible={preparerPicker !== null}
        title="Who is making this?"
        notice={
          // Only ever shown when the list is not what someone would expect —
          // never on a normal result. This used to explain the employee-code
          // gap; Task 17 fixed that gap, so saying it now would be a lie about
          // a problem that no longer exists. What remains true are the two
          // cases the rider picker also has: the list was widened past this
          // location, or there is genuinely nobody to show.
          preparerPicker?.loading ? null
            : preparerPicker?.showingEveryone
              ? 'Nobody is set up as prep staff at this location — showing everyone.'
              : (preparerPicker?.people || []).length === 0
                ? 'No prep staff yet. Ask the owner to add someone as Florist/Prep Staff.'
                : null
        }
        people={preparerPicker?.people || []}
        loading={!!preparerPicker?.loading}
        onPick={handlePickPreparer}
        onClose={closePreparerPicker}
        footer={
          preparerPicker?.loading ? null
            // Never a gate: with nobody to pick — or nobody they want to pick —
            // the order still has to be able to move. 'start' mode has
            // something to advance, so that is the offer.
            : preparerPicker?.mode === 'start' ? (
              <TouchableOpacity
                style={styles.pickerFallbackBtn}
                activeOpacity={0.7}
                onPress={handleLeavePreparerForNow}
              >
                <Text style={styles.pickerFallbackText}>Leave for now</Text>
              </TouchableOpacity>
            )
            // 'assign' mode has nothing to advance, so an empty list would
            // otherwise leave Cancel as the only way out — a soft dead end on
            // the one action this line exists to offer. Sale Detail assigns
            // per task and is the real home of the deeper case.
            : (preparerPicker?.people || []).length === 0 && preparerPicker?.order ? (
              <TouchableOpacity
                style={styles.pickerFallbackBtn}
                activeOpacity={0.7}
                onPress={() => {
                  const saleId = preparerPicker.order.id;
                  closePreparerPicker();
                  navigation.navigate('SaleDetail', { saleId });
                }}
              >
                <Text style={styles.pickerFallbackText}>Open this order</Text>
              </TouchableOpacity>
            ) : null
        }
      />

      {/* Mark Delivered with COD outstanding (resolveDeliverStep, OrderCard.js).
          One request: PUT /deliveries/:id/deliver already accepts
          cod_collected/cod_method/cod_reference and marks the order delivered
          in the same call — no separate "record it, then deliver" trip. */}
      <Modal visible={codCollectPicker !== null} transparent animationType="fade" onRequestClose={closeCodCollectPicker}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={closeCodCollectPicker}>
          <TouchableOpacity activeOpacity={1} style={styles.taskModalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Collect COD & Mark Delivered</Text>
              <TouchableOpacity onPress={closeCodCollectPicker} hitSlop={5}>
                <Ionicons name="close" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>
            <View style={styles.modalContent}>
              <Text style={styles.detailLabel}>Amount Collected</Text>
              <TextInput
                style={styles.codAmountInput}
                value={codCollectPicker?.amount || ''}
                onChangeText={(v) => setCodCollectPicker((prev) => (prev ? { ...prev, amount: v } : prev))}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor="#9CA3AF"
                editable={!codCollectPicker?.loading}
              />
              <Text style={styles.detailLabel}>Method</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {['cash', 'upi'].map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.codMethodChip, codCollectPicker?.method === m && styles.codMethodChipActive]}
                    onPress={() => setCodCollectPicker((prev) => (prev ? { ...prev, method: m } : prev))}
                    disabled={codCollectPicker?.loading}
                  >
                    <Text style={[styles.codMethodChipText, codCollectPicker?.method === m && styles.codMethodChipTextActive]}>
                      {m.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <TouchableOpacity
              style={[styles.actionBtnPrimary, codCollectPicker?.loading && { opacity: 0.6 }]}
              onPress={handleSubmitCodCollect}
              disabled={!!codCollectPicker?.loading}
            >
              {codCollectPicker?.loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.actionBtnPrimaryText}>Confirm & Mark Delivered</Text>}
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Load-verify quick flow (OrderCard's load pill) — the same
          DeliveryChecklist component DeliveryDetailScreen uses, opened right
          from the board instead of navigating there. Refetches the board on
          close so the pill's count/color is current. */}
      <Modal visible={loadChecklistOrder !== null} animationType="slide" transparent onRequestClose={closeLoadChecklist}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={closeLoadChecklist}>
          <TouchableOpacity activeOpacity={1} style={[styles.taskModalCard, { height: '70%' }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Verify Load — #{loadChecklistOrder?.sale_number}</Text>
              <TouchableOpacity onPress={closeLoadChecklist} hitSlop={5}>
                <Ionicons name="close" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>
            {loadChecklistOrder && <DeliveryChecklist deliveryId={loadChecklistOrder.delivery_id} />}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={fabVisible} transparent animationType="fade" onRequestClose={() => setFabVisible(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setFabVisible(false)}>
          <View style={styles.quickActionsCard}>
            <View style={styles.quickActionsHeader}>
              <Text style={styles.quickActionsTitle}>Quick Actions</Text>
              <TouchableOpacity onPress={() => setFabVisible(false)}>
                <Ionicons name="close" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: Colors.secondary, borderLeftWidth: 3, backgroundColor: '#F0FDF4' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'QuickCheckout', params: { locationId: activeLocation?.id } });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: Colors.secondary }]}>
                <Ionicons name="flash" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>Quick Checkout</Text>
                <Text style={styles.quickActionMeta}>Fast transaction</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: '#0EA5E9', borderLeftWidth: 3, backgroundColor: '#F0F9FF' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'POSHome' });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: '#0EA5E9' }]}>
                <Ionicons name="cart" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>POS Terminal</Text>
                <Text style={styles.quickActionMeta}>Full checkout</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: '#E11D48', borderLeftWidth: 3, backgroundColor: '#FFE4E6' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'CashRegister' });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: '#E11D48' }]}>
                <Ionicons name="wallet" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>Cash Register</Text>
                <Text style={styles.quickActionMeta}>Manage balance</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  container: { flex: 1 },
  content: { padding: 14, paddingBottom: 100 },

  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontFamily: FONT_FAMILY,
  },

  heroCard: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 18,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.primaryDark,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 8,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.primaryDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroEyebrow: {
    fontSize: 12,
    color: Colors.primaryLight,
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
    letterSpacing: 0.5,
  },
  heroTitle: {
    fontSize: 24,
    color: '#fff',
    fontWeight: '800',
    marginTop: 4,
    fontFamily: FONT_FAMILY,
  },
  heroSub: {
    fontSize: 13,
    color: Colors.primaryGlow,
    marginTop: 8,
    lineHeight: 18,
    fontFamily: FONT_FAMILY,
  },

  scopeCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 14,
  },
  scopeLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
    marginBottom: 8,
    fontFamily: FONT_FAMILY,
  },
  scopeChipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scopeChip: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: Colors.surface,
  },
  scopeChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  scopeChipText: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  scopeChipTextActive: {
    color: '#fff',
  },

  layout: { gap: 16 },
  feedCol: { gap: 8 },
  healthCol: { gap: 8 },
  // The three Team & Finance widget groups: stacked by default, a row that
  // wraps once there is real width to use (isDesktop, 1100px).
  healthRow: { gap: 8 },
  healthRowDesktop: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap' },
  healthGroup: { gap: 8 },
  healthGroupDesktop: { flex: 1, minWidth: 260 },

  sectionHeader: {
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: Colors.textLight,
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },

  widgetCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  widgetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  widgetTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  emptyWidgetText: {
    fontSize: 12,
    color: Colors.textLight,
    fontStyle: 'italic',
    fontFamily: FONT_FAMILY,
  },

  staffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderRadius: 8,
  },
  staffRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  staffName: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  staffMeta: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 1,
    fontFamily: FONT_FAMILY,
  },
  staffMetaSub: {
    fontSize: 10,
    color: Colors.secondary,
    marginTop: 2,
    fontFamily: FONT_FAMILY,
    fontWeight: '600',
  },
  pulseBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pulseBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },

  registerCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  registerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  registerStatus: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },
  registerLabel: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  registerValue: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: '800',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 8,
  },

  revenueStat: {
    alignItems: 'center',
  },
  revenueLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  revenueValue: {
    fontSize: 14,
    color: Colors.secondary,
    fontWeight: '800',
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },

  fab: {
    position: 'absolute',
    right: 20,
    bottom: 22,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#047857',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#047857',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  // AssignPickerModal's empty-state escape hatch (Task 14). Sized like a real
  // button, not a text link — 48px tall, full width, tapped in a hurry.
  pickerFallbackBtn: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
    marginTop: 4,
    marginBottom: 4,
  },
  pickerFallbackText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.primary,
    fontFamily: FONT_FAMILY,
  },
  // Collect COD & Mark Delivered modal (resolveDeliverStep, OrderCard.js).
  codAmountInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  codMethodChip: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  codMethodChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + '18',
  },
  codMethodChipText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#6B7280',
    fontFamily: FONT_FAMILY,
  },
  codMethodChipTextActive: {
    color: Colors.primary,
  },
  actionBtnPrimary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  actionBtnPrimaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    fontFamily: FONT_FAMILY,
  },
  quickActionsCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    gap: 10,
  },
  quickActionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  quickActionsTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  quickActionItem: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  quickActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  quickActionMeta: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },

  taskModalCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    marginTop: 'auto',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
    flex: 1,
    fontFamily: FONT_FAMILY,
  },
  modalContent: {
    gap: 12,
    marginBottom: 14,
  },
  detailRow: {
    gap: 8,
  },
  detailLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  detailValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
    lineHeight: 18,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  advanceButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  advanceButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    fontFamily: FONT_FAMILY,
  },

  // ─── Role-based dashboard styles ──────────────────────────
  roleStatsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  roleStatCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 4,
    alignItems: 'center',
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  roleStatCount: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  roleStatLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
  roleTaskCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  roleTaskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  roleTaskName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    marginRight: 8,
    fontFamily: FONT_FAMILY,
  },
  roleTaskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  roleTaskBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: FONT_FAMILY,
  },
  roleTaskMeta: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },
  orderQuickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  orderQuickActionText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
  roleActionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  roleActionBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    fontFamily: FONT_FAMILY,
  },
  roleEmptyCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  codBannerCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 12,
  },
  codBannerCompactText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
    fontFamily: FONT_FAMILY,
  },
  roleEmptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#065F46',
    fontFamily: FONT_FAMILY,
  },
  roleEmptyText: {
    fontSize: 13,
    color: '#6B7280',
    fontFamily: FONT_FAMILY,
  },

  // Customer view (see the isCustomer branch). Deliberately big, plain and
  // two-choice — this is the whole screen for that role.
  customerCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  customerCardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  customerCardText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    fontFamily: FONT_FAMILY,
  },
  customerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 56,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  customerBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
    fontFamily: FONT_FAMILY,
  },
  customerBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 56,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  customerBtnSecondaryText: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.primary,
    fontFamily: FONT_FAMILY,
  },
});
