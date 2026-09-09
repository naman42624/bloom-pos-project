// Bulk multi-day register-session fetch for the Orders Inbox SectionList.
// See docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2
// for why this is a separate hook from useRegisterSessions rather than that
// hook called in a loop (React's rules of hooks forbid that outright).
import { useState, useEffect } from 'react';
import api from '../services/api';

export default function useSessionsForDates(locationId, dateKeys) {
  const [sessionsByDate, setSessionsByDate] = useState({});
  const [loading, setLoading] = useState(false);
  // Array identity changes every render even with the same contents (a new
  // groupOrdersByDay() call each render) — join to a stable string so the
  // effect only re-runs when the actual set of days changes.
  const keysSignature = (dateKeys || []).join(',');

  useEffect(() => {
    const keys = keysSignature ? keysSignature.split(',') : [];
    if (!locationId || keys.length === 0) {
      setSessionsByDate({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      keys.map((dateKey) =>
        api.getRegisterSessions({ location_id: locationId, date: dateKey })
          .then((res) => [dateKey, res.data?.sessions || []])
          .catch(() => [dateKey, []])
      )
    ).then((entries) => {
      if (cancelled) return;
      setSessionsByDate(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, keysSignature]);

  return { sessionsByDate, loading };
}
