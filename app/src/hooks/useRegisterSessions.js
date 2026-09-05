// Register-session lookup for DateSessionHeader — no new database column
// (design doc §3.3): a session is fully described by cash_registers'
// opened_at/opening_time -> closed_at window, fetched once per (location,
// date) pair and matched against order timestamps client-side.
import { useState, useEffect } from 'react';
import api from '../services/api';
import { matchSessionLabel } from '../utils/registerSessions';

const cache = new Map(); // `${locationId}:${dateStr}` -> sessions array, cleared on reload — a purely in-memory speedup, not persistence

export default function useRegisterSessions(locationId, dateStr) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!locationId || !dateStr) { setSessions([]); setLoading(false); return; }
    const key = `${locationId}:${dateStr}`;
    if (cache.has(key)) { setSessions(cache.get(key)); setLoading(false); return; }
    setLoading(true);
    api.getRegisterSessions({ location_id: locationId, date: dateStr })
      .then((res) => {
        const list = res.data?.sessions || [];
        cache.set(key, list);
        setSessions(list);
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [locationId, dateStr]);

  return { sessions, loading };
}

// Re-exported (not defined here) so it's a pure, independently testable
// function with zero React/api dependency — the actual implementation and
// its boundary-condition documentation live in
// app/src/utils/registerSessions.js, alongside its plain-Node assert script
// (app/scripts/verify-register-sessions.js). Kept re-exported from this
// file too so a consumer can still do
// `import useRegisterSessions, { matchSessionLabel } from
// '../hooks/useRegisterSessions'` as the single expected entry point.
export { matchSessionLabel };
