import { useEffect, useRef, useCallback } from 'react';
import api from '../services/api';

const WEB_GEOFENCE_INTERVAL = 30000;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const toRadians = (deg) => (deg * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findContainingLocation(position, locations) {
  if (!position || !locations?.length) return null;
  const { latitude, longitude } = position.coords || {};
  if (latitude == null || longitude == null) return null;

  const shopLocations = locations
    .filter((location) => location?.type === 'shop' && location?.latitude && location?.longitude)
    .map((location) => {
      const radius = Number(location.geofence_radius || 100);
      const distance = haversineMeters(latitude, longitude, Number(location.latitude), Number(location.longitude));
      return distance <= radius ? { location, distance } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);

  return shopLocations[0]?.location || null;
}

export default function useGeofence({ user, locations, enabled = true }) {
  const isMonitoring = useRef(false);
  const watchIdRef = useRef(null);
  const lastInsideLocationIdRef = useRef(null);

  const stopGeofencing = useCallback(() => {
    if (watchIdRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    isMonitoring.current = false;
    lastInsideLocationIdRef.current = null;
  }, []);

  const emitGeofenceEvent = useCallback(async (location, eventType, position) => {
    try {
      await api.recordGeofenceEvent({
        location_id: location.id,
        event_type: eventType,
        latitude: position?.coords?.latitude ?? null,
        longitude: position?.coords?.longitude ?? null,
      });
    } catch (error) {
      console.error('Failed to record web geofence event:', error);
    }
  }, []);

  const startGeofencing = useCallback(async () => {
    if (!enabled || !user || user.role === 'owner' || user.role === 'customer') return;
    if (!locations || locations.length === 0) return;
    if (isMonitoring.current) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation?.watchPosition) return;

    const handlePosition = async (position) => {
      const containingLocation = findContainingLocation(position, locations);
      const currentLocationId = containingLocation?.id || null;

      if (currentLocationId && lastInsideLocationIdRef.current !== currentLocationId) {
        if (lastInsideLocationIdRef.current) {
          const previous = locations.find((location) => location.id === lastInsideLocationIdRef.current);
          if (previous) {
            await emitGeofenceEvent(previous, 'exit', position);
          }
        }

        lastInsideLocationIdRef.current = currentLocationId;
        await emitGeofenceEvent(containingLocation, 'enter', position);
        return;
      }

      if (!currentLocationId && lastInsideLocationIdRef.current) {
        const previous = locations.find((location) => location.id === lastInsideLocationIdRef.current);
        lastInsideLocationIdRef.current = null;
        if (previous) {
          await emitGeofenceEvent(previous, 'exit', position);
        }
      }
    };

    const handleError = (error) => {
      console.warn('Web geofence watcher unavailable:', error?.message || error);
    };

    try {
      watchIdRef.current = navigator.geolocation.watchPosition(
        handlePosition,
        handleError,
        { enableHighAccuracy: true, maximumAge: WEB_GEOFENCE_INTERVAL, timeout: WEB_GEOFENCE_INTERVAL }
      );
      isMonitoring.current = true;

      navigator.geolocation.getCurrentPosition(
        handlePosition,
        handleError,
        { enableHighAccuracy: true, maximumAge: WEB_GEOFENCE_INTERVAL, timeout: WEB_GEOFENCE_INTERVAL }
      );
    } catch (error) {
      console.error('Failed to start web geofencing:', error);
      stopGeofencing();
    }
  }, [enabled, emitGeofenceEvent, locations, stopGeofencing, user]);

  useEffect(() => {
    startGeofencing();
    return () => {
      stopGeofencing();
    };
  }, [startGeofencing, stopGeofencing]);

  return { isMonitoring: isMonitoring.current, startGeofencing, stopGeofencing };
}
