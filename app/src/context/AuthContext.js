import React, { createContext, useContext, useEffect, useReducer } from 'react';
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
};

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
        locked: isSharedDeviceStaffRole(action.user?.role),
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
  const [state, dispatch] = useReducer(authReducer, initialState);

  // Restore saved session on app start
  useEffect(() => {
    async function restoreSession() {
      try {
        const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
        const userJson = await AsyncStorage.getItem(STORAGE_KEY_USER);
        const locationJson = await AsyncStorage.getItem(STORAGE_KEY_LOCATION);

        if (token && userJson) {
          const user = JSON.parse(userJson);
          api.setToken(token);

          try {
            const response = await api.getProfile();
            const activeLocation = locationJson ? JSON.parse(locationJson) : null;
            const settingsRes = await api.getSettings().catch(() => ({ data: {} }));
            dispatch({
              type: 'RESTORE_TOKEN',
              token,
              user: response.data.user,
              locations: response.data.locations || [],
              activeLocation,
            });
            dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
          } catch {
            await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER, STORAGE_KEY_LOCATION]);
            api.clearToken();
            // Check setup status for fresh start
            await checkSetupStatus();
          }
        } else {
          await checkSetupStatus();
        }
      } catch {
        dispatch({ type: 'SET_SETUP_STATUS', isSetupComplete: false });
      }
    }

    restoreSession();
  }, []);

  async function checkSetupStatus() {
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

    dispatch({ type: 'LOGIN', user, token, locations, activeLocation });

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

    try {
      const settingsRes = await api.getSettings();
      dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
    } catch (e) {
      console.log('Failed to fetch settings after staff login:', e);
    }

    return response;
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
    await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_USER, STORAGE_KEY_LOCATION]);
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
