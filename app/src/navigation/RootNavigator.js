import React from 'react';
import { View } from 'react-native';
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
      <NavigationContainer onStateChange={bump}>
        {!isAuthenticated ? (
          <AuthNavigator showSetup={isSetupComplete === false} />
        ) : locked ? (
          <LockedNavigator />
        ) : (
          <MainNavigator />
        )}
      </NavigationContainer>
    </View>
  );
}
