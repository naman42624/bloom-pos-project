import React, { createContext, useContext, useEffect, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

const AuthContext = createContext(null);

// Roles that share a single counter device (employee-code + PIN login,
// idle-lock, Switch User tile grid). Owner/manager/delivery_partner/customer
// use their own personal device with phone+password and are unaffected by
// any of that shared-device machinery. Single source of truth — used by
// RESTORE_TOKEN below, RootNavigator's idle-lock gate, and SwitchUserButton's
// render gate. Don't duplicate this role list anywhere else.
export function isSharedDeviceStaffRole(role) {
  return ['employee', 'counter_staff', 'florist_staff'].includes(role);
}

const STORAGE_KEY_TOKEN = '@bloomcart_token';
const STORAGE_KEY_USER = '@bloomcart_user';
const STORAGE_KEY_LOCATION = '@bloomcart_active_location';
const STORAGE_KEY_DEVICE_LOCATION = '@bloomcart_device_location';
// A helper's own phone, set up from a join link. The id says whose phone it
// is; the profile ({ id, name, employee_code }) is kept apart from the
// session keys so the lock screen can still show their PIN pad after a
// logout or an ended access window clears the session.
const STORAGE_KEY_PERSONAL_DEVICE = '@petal_personal_device';
const STORAGE_KEY_PERSONAL_DEVICE_USER = '@petal_personal_device_user';

// Helpers may only call the routes in server/utils/helper-routes.js, and
// GET /settings is not one of them, so their sessions skip that fetch.
function canReadSettings(user) {
  return user?.role !== 'helper';
}

// Locked on app start: shared-device staff, and helpers on their own phone.
function locksOnRestore(role) {
  return isSharedDeviceStaffRole(role) || role === 'helper';
}

async function clearPersonalDeviceKeys() {
  try {
    await AsyncStorage.multiRemove([STORAGE_KEY_PERSONAL_DEVICE, STORAGE_KEY_PERSONAL_DEVICE_USER]);
  } catch { /* storage unavailable — nothing stored to clear */ }
}

async function readPersonalDevice() {
  try {
    const id = await AsyncStorage.getItem(STORAGE_KEY_PERSONAL_DEVICE);
    const json = await AsyncStorage.getItem(STORAGE_KEY_PERSONAL_DEVICE_USER);
    if (!id || !json) return null;
    const profile = JSON.parse(json);
    if (!profile || String(profile.id) !== String(id) || !profile.employee_code) return null;
    return profile;
  } catch {
    return null;
  }
}

// ─── Reducer ──────────────────────────────────────────────────
const initialState = {
  user: null,
  token: null,
  locations: [],
  activeLocation: null,
  isLoading: true,
  isAuthenticated: false,
  isSetupComplete: null,
  settings: {},
  locked: true,
  // { id, name, employee_code } when this is a helper's own phone, else null.
  personalDevice: null,
  // Plain-language reason shown on the lock screen (e.g. access ended).
  lockMessage: null,
  // True when this phone was a helper's and has just been released: show the
  // shared lock screen (staff roster) even though nobody is signed in.
  deviceLock: false,
};

// The server's access-ended copy ("Your access ended on 15 Nov. ...").
export function isAccessEndedMessage(message) {
  return typeof message === 'string' && /^Your access ended on /.test(message);
}

function authReducer(state, action) {
  switch (action.type) {
    case 'SET_SETUP_STATUS':
      return { ...state, isSetupComplete: action.isSetupComplete, isLoading: false };
    case 'RESTORE_TOKEN':
      return {
        ...state,
        user: action.user,
        token: action.token,
        locations: action.locations || [],
        activeLocation: action.activeLocation || null,
        isLoading: false,
        isAuthenticated: !!action.token,
        isSetupComplete: true,
        // Shared-device staff (employee/counter_staff/florist_staff) must
        // always come back locked on a fresh app launch/reopen — a stored
        // token surviving a force-quit must never hand whoever reopens the
        // app someone else's already-unlocked session. Owner/manager/
        // delivery_partner/customer use their own personal device and
        // restore normally, unaffected.
        // Helpers on their own phone come back locked too (their PIN pad).
        locked: locksOnRestore(action.user?.role),
        personalDevice: action.personalDevice || null,
        lockMessage: null,
        deviceLock: false,
      };
    case 'PERSONAL_LOCK':
      // A helper's own phone with no live session (logged out, or access
      // ended): show only that helper's PIN pad, with the reason if any.
      return {
        ...state,
        user: null,
        token: null,
        locations: [],
        activeLocation: null,
        isLoading: false,
        isAuthenticated: false,
        isSetupComplete: true,
        locked: true,
        personalDevice: action.personalDevice,
        lockMessage: action.lockMessage || null,
        deviceLock: false,
      };
    case 'PERSONAL_RELEASE':
      // The helper this phone belonged to is gone (unknown code or switched
      // off): back to the shop's shared lock screen, saying why.
      return {
        ...state,
        user: null,
        token: null,
        locations: [],
        activeLocation: null,
        isLoading: false,
        isAuthenticated: false,
        isSetupComplete: true,
        locked: true,
        personalDevice: null,
        lockMessage: action.lockMessage || null,
        deviceLock: true,
      };
    case 'LOGIN':
      return {
        ...state,
        user: action.user,
        token: action.token,
        locations: action.locations || [],
        activeLocation: action.activeLocation || null,
        isLoading: false,
        isAuthenticated: true,
        isSetupComplete: true,
        locked: false,
        personalDevice: action.personalDevice !== undefined ? action.personalDevice : state.personalDevice,
        lockMessage: null,
        deviceLock: false,
      };
    case 'LOCK':
      return { ...state, locked: true };
    case 'UNLOCK':
      return { ...state, locked: false };
    case 'LOGOUT':
      return {
        ...state,
        user: null,
        token: null,
        locations: [],
        activeLocation: null,
        isLoading: false,
        isAuthenticated: false,
        deviceLock: false,
      };
    case 'UPDATE_USER':
      return { ...state, user: { ...state.user, ...action.user } };
    case 'SET_ACTIVE_LOCATION':
      return { ...state, activeLocation: action.location };
    case 'SET_SETTINGS':
      return { ...state, settings: action.settings || {} };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    default:
      return state;
  }
}

// ─── Provider ─────────────────────────────────────────────────
export function AuthProvider({ children }) {
  const [state, rawDispatch] = useReducer(authReducer, initialState);
  const dispatch = rawDispatch;
  // Set the moment completeJoin runs. A session restore still in flight
  // (started when the join page opened) must not overwrite the new helper
  // session afterwards, so every restore step checks this and stops.
  const joinedRef = useRef(false);

  // Restore saved session on app start
  useEffect(() => {
    const restoreDispatch = (action) => { if (!joinedRef.current) rawDispatch(action); };
    async function restoreSession() {
      const dispatch = restoreDispatch;
      const checkSetupStatus = () => checkSetupStatusWith(restoreDispatch);
      const personalDevice = await readPersonalDevice();
      try {
        const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
        const userJson = await AsyncStorage.getItem(STORAGE_KEY_USER);
        const locationJson = await AsyncStorage.getItem(STORAGE_KEY_LOCATION);

        if (token && userJson) {
          const user = JSON.parse(userJson);
          if (joinedRef.current) return;
          api.setToken(token);

          try {
            const response = await api.getProfile();
            const activeLocation = locationJson ? JSON.parse(locationJson) : null;
            const settingsRes = canReadSettings(response.data.user)
              ? await api.getSettings().catch(() => ({ data: {} }))
              : { data: {} };
            dispatch({
              type: 'RESTORE_TOKEN',
              token,
              user: response.data.user,
              locations: response.data.locations || [],
              activeLocation,
              personalDevice,
            });
            dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
          } catch (err) {
            try {
              await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER, STORAGE_KEY_LOCATION]);
            } catch { /* storage unavailable — the session is dropped in memory anyway */ }
            if (joinedRef.current) return;
            api.clearToken();
            if (personalDevice) {
              // e.g. 401 "Your access ended on 15 Nov. ..." — say it on the
              // lock screen instead of dropping to the owner login page.
              // Other refusals (user gone, switched off) are sorted out by
              // the PIN pad's staff-login answer, so show nothing yet.
              const message = err && isAccessEndedMessage(err.message) ? err.message : null;
              dispatch({ type: 'PERSONAL_LOCK', personalDevice, lockMessage: message });
              return;
            }
            // Check setup status for fresh start
            await checkSetupStatus();
          }
        } else if (personalDevice) {
          dispatch({ type: 'PERSONAL_LOCK', personalDevice });
        } else {
          await checkSetupStatus();
        }
      } catch {
        if (personalDevice) {
          dispatch({ type: 'PERSONAL_LOCK', personalDevice });
          return;
        }
        dispatch({ type: 'SET_SETUP_STATUS', isSetupComplete: false });
      }
    }

    restoreSession();
  }, []);

  async function checkSetupStatusWith(dispatch) {
    try {
      const response = await api.getSetupStatus();
      dispatch({
        type: 'SET_SETUP_STATUS',
        isSetupComplete: response.data.isSetupComplete,
      });
    } catch {
      dispatch({ type: 'SET_SETUP_STATUS', isSetupComplete: false });
    }
  }

  // ─── Actions ──────────────────────────────────────────────
  const login = async (phone, password) => {
    const response = await api.login(phone, password);
    const { user, token, locations } = response.data;

    // An owner/manager signing in with phone + password takes the phone
    // back: it is no longer a helper's personal device.
    await clearPersonalDeviceKeys();

    api.setToken(token);
    await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    // Auto-select first location if available
    const activeLocation = locations && locations.length > 0 ? locations[0] : null;
    if (activeLocation) {
      await AsyncStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(activeLocation));
      // Remember this location on the device itself (not just this user's
      // session) so LockScreen can fetch the right staff roster on a cold
      // start, before anyone has unlocked/logged in yet.
      await setDeviceLocationId(activeLocation.id);
    }

    dispatch({ type: 'LOGIN', user, token, locations, activeLocation, personalDevice: null });

    try {
      const settingsRes = await api.getSettings();
      dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
    } catch (e) {
      console.log('Failed to fetch settings after login:', e);
    }

    return response;
  };

  const staffLogin = async (employeeCode, pin) => {
    const response = await api.staffLogin(employeeCode, pin);
    const { user, token, locations } = response.data;

    api.setToken(token);
    await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    const activeLocation = locations && locations.length > 0 ? locations[0] : null;
    if (activeLocation) {
      await AsyncStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(activeLocation));
      await setDeviceLocationId(activeLocation.id);
    }

    dispatch({ type: 'LOGIN', user, token, locations, activeLocation });

    if (canReadSettings(user)) {
      try {
        const settingsRes = await api.getSettings();
        dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
      } catch (e) {
        console.log('Failed to fetch settings after staff login:', e);
      }
    }

    return response;
  };

  // A helper just set their PIN from a join link (POST /auth/join answers
  // exactly like staff-login). Store the session the same way, and mark this
  // phone as theirs so the lock screen shows only their PIN pad from now on.
  const completeJoin = async (session) => {
    joinedRef.current = true;
    const { user, token, locations } = session;
    api.setToken(token);
    const activeLocation = locations && locations.length > 0 ? locations[0] : null;
    const personalDevice = { id: user.id, name: user.name, employee_code: user.employee_code };
    try {
      // Marker first: if a later write fails, a reload still shows this
      // helper's PIN pad (their PIN works) rather than someone else's session.
      await AsyncStorage.setItem(STORAGE_KEY_PERSONAL_DEVICE_USER, JSON.stringify(personalDevice));
      await AsyncStorage.setItem(STORAGE_KEY_PERSONAL_DEVICE, String(user.id));
      await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
      await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
      if (activeLocation) {
        await AsyncStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(activeLocation));
        await setDeviceLocationId(activeLocation.id);
      }
    } catch (e) {
      // Storage blocked (private mode): this visit still works, but a reload
      // will need the join link again.
      console.log('Could not save the helper session on this device:', e);
    }
    dispatch({ type: 'LOGIN', user, token, locations, activeLocation, personalDevice });
  };

  // The PIN pad's staff-login said this phone's helper is unknown or switched
  // off: forget them and show the shop's shared lock screen with `message`.
  const releasePersonalDevice = async (message) => {
    api.clearToken();
    await clearPersonalDeviceKeys();
    try {
      await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER, STORAGE_KEY_LOCATION]);
    } catch { /* storage unavailable — the in-memory session is cleared below */ }
    dispatch({ type: 'PERSONAL_RELEASE', lockMessage: message });
  };

  const lock = () => dispatch({ type: 'LOCK' });
  const unlock = () => dispatch({ type: 'UNLOCK' });

  const register = async (data) => {
    const response = await api.register(data);
    const { user, token } = response.data;

    api.setToken(token);
    await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    dispatch({ type: 'LOGIN', user, token, locations: [], activeLocation: null });
    return response;
  };

  const ownerSetup = async (data) => {
    const response = await api.ownerSetup(data);
    const { user, token } = response.data;

    api.setToken(token);
    await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    dispatch({ type: 'LOGIN', user, token, locations: [], activeLocation: null });
    return response;
  };

  const logout = async () => {
    api.clearToken();
    try {
      await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER, STORAGE_KEY_LOCATION]);
    } catch { /* storage unavailable — the in-memory session is cleared below */ }
    // A helper's own phone stays theirs: back to their PIN pad, not the login page.
    if (state.personalDevice) {
      dispatch({ type: 'PERSONAL_LOCK', personalDevice: state.personalDevice });
      return;
    }
    dispatch({ type: 'LOGOUT' });
  };

  const updateUser = async (data) => {
    const response = await api.updateProfile(data);
    const user = response.data.user;

    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
    dispatch({ type: 'UPDATE_USER', user });
    return response;
  };

  const setActiveLocation = async (location) => {
    await AsyncStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(location));
    dispatch({ type: 'SET_ACTIVE_LOCATION', location });
  };

  const setDeviceLocationId = async (locationId) => {
    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_LOCATION, String(locationId));
  };

  const getDeviceLocationId = async () => {
    return AsyncStorage.getItem(STORAGE_KEY_DEVICE_LOCATION);
  };

  const refreshSettings = async () => {
    try {
      const settingsRes = await api.getSettings();
      dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
    } catch (e) {
      console.log('Failed to refresh settings:', e);
    }
  };

  const value = {
    ...state,
    login,
    staffLogin,
    completeJoin,
    releasePersonalDevice,
    register,
    ownerSetup,
    logout,
    lock,
    unlock,
    updateUser,
    setActiveLocation,
    setDeviceLocationId,
    getDeviceLocationId,
    refreshSettings,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
