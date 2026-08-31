import React from 'react';
import { View, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth, isSharedDeviceStaffRole } from '../context/AuthContext';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LockScreen from '../screens/LockScreen';
import LoadingScreen from '../components/LoadingScreen';
import useIdleLock from '../hooks/useIdleLock';

const LockStack = createNativeStackNavigator();

function LockedNavigator() {
  return (
    <LockStack.Navigator screenOptions={{ headerShown: false }}>
      <LockStack.Screen name="Lock" component={LockScreen} />
      <LockStack.Screen name="Login" component={AuthNavigator} />
    </LockStack.Navigator>
  );
}

export default function RootNavigator() {
  const { isAuthenticated, isLoading, isSetupComplete, locked, lock, user } = useAuth();
  // Idle-lock only applies to shared-device staff roles (employee/
  // counter_staff/florist_staff). Owner/manager/delivery_partner/customer
  // use their own personal device and must never be auto-locked into the
  // staff PIN tile grid.
  const { bump } = useIdleLock(isAuthenticated && !locked && isSharedDeviceStaffRole(user?.role), lock);

  if (isLoading) {
    return <LoadingScreen message="Starting Flower point..." />;
  }

  return (
    // onTouchStart (not claiming the responder) gives useIdleLock a real
    // touch-based activity signal in addition to onStateChange, so
    // single-screen flows (checkout, log order, register close-out) that
    // never trigger a navigation state change don't get idle-locked out
    // from under an in-progress cart. Plain onTouchStart doesn't claim the
    // responder, so it doesn't interfere with children's own gesture
    // handling (scroll, swipe, buttons all still work as before).
    <View style={{ flex: 1 }} onTouchStart={bump}>
      {!isAuthenticated ? (
        <NavigationContainer onStateChange={bump}>
          <AuthNavigator showSetup={isSetupComplete === false} />
        </NavigationContainer>
      ) : (
        <>
          {/* MainNavigator stays mounted through a lock, instead of being
              swapped out for LockedNavigator — locking used to UNMOUNT
              whatever screen was active, wiping any in-progress local
              state (a half-filled order in LogOrderScreen, an open
              checkout cart) the instant the idle timer fired. Reported
              live: a staff member lost a whole order to this. Now the
              lock screen is an overlay on top of the still-mounted app,
              so re-entering the PIN drops you back exactly where you
              were — nothing to redo.
              `key={user?.id}` is what keeps this safe for the shared-
              device PIN quick-switch this app is built around: if the
              SAME person re-authenticates, their id is unchanged, so
              React reuses the exact same mounted tree (state intact). If
              a DIFFERENT staff member picks their own tile and PIN, the
              key changes and React remounts MainNavigator from scratch —
              so the next person never inherits a stranger's half-typed
              order or sees data they shouldn't (2026-09-01). */}
          <NavigationContainer key={`main-${user?.id}`} onStateChange={bump}>
            <MainNavigator />
          </NavigationContainer>
          {locked && (
            <View style={StyleSheet.absoluteFill}>
              <NavigationContainer>
                <LockedNavigator />
              </NavigationContainer>
            </View>
          )}
        </>
      )}
    </View>
  );
}
