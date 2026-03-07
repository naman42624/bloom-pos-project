import React, { createContext, useContext, useEffect, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

const AuthContext = createContext(null);

const STORAGE_KEY_TOKEN = '@bloomcart_token';
const STORAGE_KEY_USER = '@bloomcart_user';
const STORAGE_KEY_LOCATION = '@bloomcart_active_location';

// ─── Reducer ──────────────────────────────────────────────────
const initialState = {
  user: null,
  token: null,
  locations: [],
  activeLocation: null,
  isLoading: true,
  isAuthenticated: false,
  isSetupComplete: null, // null = unknown, true/false = checked
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
      };
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
            dispatch({
              type: 'RESTORE_TOKEN',
              token,
              user: response.data.user,
              locations: response.data.locations || [],
              activeLocation,
            });
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
    }

    dispatch({ type: 'LOGIN', user, token, locations, activeLocation });
    return response;
  };

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

  const value = {
    ...state,
    login,
    register,
    ownerSetup,
    logout,
    updateUser,
    setActiveLocation,
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
