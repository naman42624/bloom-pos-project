// Shared by the helper's Sell and My sales screens.
//   locationId  — this phone's shop (the device location, if the helper works
//                 there; else their first shop)
//   handleAccessEnded(err) — true when err was the server's "Your access
//                 ended on ..." 401: the app has already gone to the helper's
//                 PIN pad with that message, so the caller shows nothing.
import { useCallback, useEffect, useState } from 'react';
import { useAuth, isAccessEndedMessage } from '../../context/AuthContext';

export default function useHelperSession() {
  const { activeLocation, locations, getDeviceLocationId, lockWithMessage } = useAuth();
  const [deviceLocationId, setDeviceLocationId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const id = await getDeviceLocationId();
        if (alive && id) setDeviceLocationId(Number(id));
      } catch { /* storage unavailable — fall back to the first shop */ }
    })();
    return () => { alive = false; };
    // Read once: the device location does not change while the app is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = Array.isArray(locations) ? locations : [];
  const worksAtDevice = deviceLocationId && list.some((l) => Number(l.id) === deviceLocationId);
  const locationId = worksAtDevice
    ? deviceLocationId
    : (activeLocation?.id || list[0]?.id || null);

  const handleAccessEnded = useCallback((err) => {
    if (err && err.status === 401 && isAccessEndedMessage(err.message)) {
      lockWithMessage(err.message);
      return true;
    }
    return false;
  }, [lockWithMessage]);

  return { locationId, handleAccessEnded };
}
