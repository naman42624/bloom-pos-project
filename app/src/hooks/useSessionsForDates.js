// Bulk multi-day register-session fetch for the Orders Inbox SectionList.
// See docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2
// for why this is a separate hook from useRegisterSessions rather than that
// hook called in a loop (React's rules of hooks forbid that outright).
import { useState, useEffect, useRef } from 'react';
import api from '../services/api';

export default function useSessionsForDates(locationId, dateKeys) {
  const [sessionsByDate, setSessionsByDate] = useState({});
  const [loading, setLoading] = useState(false);
  // Array identity changes every render even with the same contents (a new
  // groupOrdersByDay() call each render) — join to a stable string so the
  // effect only re-runs when the actual set of days changes.
  const keysSignature = (dateKeys || []).join(',');

  // Latest-value ref for sessionsByDate, read (not depended-on) inside the
  // effect below so it can tell which keys are already fetched without
  // putting sessionsByDate itself in the dependency array — doing that would
  // re-run the effect every time its own setSessionsByDate call updates
  // state, an infinite loop.
  const sessionsByDateRef = useRef(sessionsByDate);
  useEffect(() => { sessionsByDateRef.current = sessionsByDate; }, [sessionsByDate]);
  // Tracks the locationId the cache was built for, so a location change is
  // detected inside the effect below and starts the cache fresh — without
  // this, sessionsByDateRef would still hold the OLD location's entries and
  // the "skip already-fetched keys" logic would wrongly skip re-fetching
  // same-named date keys for the NEW location.
  const cachedLocationIdRef = useRef(locationId);

  useEffect(() => {
    const keys = keysSignature ? keysSignature.split(',') : [];
    if (!locationId || keys.length === 0) {
      setSessionsByDate({});
      sessionsByDateRef.current = {};
      cachedLocationIdRef.current = locationId;
      return;
    }
    const locationChanged = cachedLocationIdRef.current !== locationId;
    if (locationChanged) {
      // A different location means the cached entries belong to the WRONG
      // location's sessions — start fresh rather than treating those dates
      // as already-fetched (which would both wrongly skip fetching them for
      // the new location, and leak the old location's session labels into
      // this render until a fetch happened to overwrite that key again).
      sessionsByDateRef.current = {};
      cachedLocationIdRef.current = locationId;
      setSessionsByDate({});
    }
    // Only fetch days not already present in the cache — pagination ("Load
    // more") widens the set of distinct days on every call, and without
    // this, every subsequent call would re-fetch every previously-seen day
    // too, growing without bound. This is scoped to a single mount for an
    // unchanged locationId only: a location change (handled just above) or
    // unmount (a fresh mount starts with fresh state) still starts fresh,
    // so the "cache never invalidates" problem this hook was built to avoid
    // (see file header) is not reintroduced.
    const missingKeys = keys.filter((k) => !(k in sessionsByDateRef.current));
    if (missingKeys.length === 0) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(
      missingKeys.map((dateKey) =>
        api.getRegisterSessions({ location_id: locationId, date: dateKey })
          .then((res) => [dateKey, res.data?.sessions || []])
          .catch(() => [dateKey, []])
      )
    ).then((entries) => {
      if (cancelled) return;
      setSessionsByDate((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, keysSignature]);

  return { sessionsByDate, loading };
}
