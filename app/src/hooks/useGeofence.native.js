import { useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';
import api from '../services/api';

const GEOFENCE_TASK = 'BLOOMCART_GEOFENCE_TASK';

// Register geofence task at module level (required by expo-task-manager)
try {
  if (!TaskManager.isTaskDefined || !TaskManager.isTaskDefined(GEOFENCE_TASK)) {
    TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error) {
      console.error('Geofence task error:', error);
      return;
    }
    if (!data) return;

    const { eventType, region } = data;
    const locationId = region?.identifier ? Number(region.identifier) : null;
    if (!locationId) return;

    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const eventPayload = {
        location_id: locationId,
        event_type: eventType === Location.GeofencingEventType.Enter ? 'enter' : 'exit',
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      await api.recordGeofenceEvent(eventPayload);
    } catch (e) {
      console.error('Geofence event recording failed:', e);
    }
    });
  }
} catch (e) {
  console.warn('Geofence task registration skipped:', e?.message || e);
}

export default function useGeofence({ user, locations, enabled = true }) {
  const isMonitoring = useRef(false);
  const hasTriedRef = useRef(false);
  // Stabilise locations to avoid re-triggering on every render
  const locationsKey = JSON.stringify(
    (locations || [])
      .filter(l => l.latitude && l.longitude && l.type === 'shop')
      .map(l => `${l.id}:${l.latitude}:${l.longitude}:${l.geofence_radius}`)
  );

  const startGeofencing = useCallback(async () => {
    if (!enabled || !user || user.role === 'owner' || user.role === 'customer') return;
    if (!locations || locations.length === 0) return;
    if (isMonitoring.current) return;

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        hasTriedRef.current = true;
        return;
      }

      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        console.warn('Background location permission not granted — geofencing requires "Always Allow" location permission');
        hasTriedRef.current = true;
        return; // Don't attempt geofencing without background permission
      }

      // Build geofence regions from shop locations
      const regions = locations
        .filter(l => l.latitude && l.longitude && l.type === 'shop')
        .map(l => ({
          identifier: String(l.id),
          latitude: Number(l.latitude),
          longitude: Number(l.longitude),
          radius: l.geofence_radius || 100, // default 100m
          notifyOnEnter: true,
          notifyOnExit: true,
        }));

      if (regions.length === 0) {
        hasTriedRef.current = true;
        return;
      }

      // Stop any existing geofencing first
      const isRegistered = await TaskManager.isTaskRegisteredAsync(GEOFENCE_TASK);
      if (isRegistered) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK);
      }

      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
      isMonitoring.current = true;
      hasTriedRef.current = true;
    } catch (e) {
      console.error('Failed to start geofencing:', e);
      hasTriedRef.current = true; // Don't retry on error
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, user?.id, user?.role, locationsKey]);

  const stopGeofencing = useCallback(async () => {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(GEOFENCE_TASK);
      if (isRegistered) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK);
      }
      isMonitoring.current = false;
      hasTriedRef.current = false;
    } catch (e) {
      console.error('Failed to stop geofencing:', e);
    }
  }, []);

  useEffect(() => {
    if (!hasTriedRef.current) {
      startGeofencing();
    }
    return () => { stopGeofencing(); };
  }, [startGeofencing, stopGeofencing]);

  // Re-start geofencing when app comes to foreground (only if previously successful)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && enabled && isMonitoring.current) {
        // Re-validate that geofencing is still registered
        TaskManager.isTaskRegisteredAsync(GEOFENCE_TASK).then(registered => {
          if (!registered) {
            isMonitoring.current = false;
            hasTriedRef.current = false;
            startGeofencing();
          }
        });
      }
    });
    return () => sub?.remove();
  }, [enabled, startGeofencing]);

  return { isMonitoring: isMonitoring.current, startGeofencing, stopGeofencing };
}
