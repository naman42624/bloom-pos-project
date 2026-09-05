import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { isToday } from '../utils/datetime';

/**
 * Whether a register session was opened on a day before today (shop
 * timezone), i.e. it's spanned a day boundary while staying open. Purely a
 * display concern — hasOpenRegister/the close math (server/utils/
 * register-guard.js, PUT /sales/register/close) are already correctly
 * timestamp-scoped and don't care what calendar day a session started on.
 * This is the ONE place that decides "stale" so CashRegisterScreen, the
 * owner's RegisterCard, and the counter/employee widget can't drift into
 * disagreeing about it (2026-09-04 cash-register/expense audit).
 */
export function isRegisterStale(register) {
  const openedAt = register?.opening_time || register?.opened_at;
  return !!openedAt && !isToday(openedAt);
}

/**
 * Fetches register status for one location and exposes it as
 * { loading, isOpen, isStale, register, pendingCodTotal, pendingCodDeliveries, error, refetch }.
 *
 * Screens that already pull register status as part of a larger dashboard
 * fetch (DashboardScreen.js) don't need this hook — they already have the
 * data, and can call isRegisterStale() above directly on it. This hook is
 * for screens that need register awareness on their own, with nothing else
 * to piggyback on (ExpensesScreen.js, the first real gap this was built
 * for — audit RefundSaleScreen/SettlementsScreen/checkout for the same gap
 * before assuming they need it too, some may already have their own check).
 */
export default function useRegisterStatus(locationId) {
  const [state, setState] = useState({
    loading: true,
    isOpen: false,
    isStale: false,
    register: null,
    pendingCodTotal: 0,
    pendingCodDeliveries: 0,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    if (!locationId) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.getRegisterStatus(locationId);
      const isOpen = !!res?.isOpen;
      setState({
        loading: false,
        isOpen,
        isStale: isOpen && isRegisterStale(res?.data),
        register: res?.data || null,
        pendingCodTotal: Number(res?.pendingCodTotal || 0),
        pendingCodDeliveries: Number(res?.pendingCodDeliveries || 0),
        error: null,
      });
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err?.message || 'Could not load register status.' }));
    }
  }, [locationId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return { ...state, refetch: fetchStatus };
}
