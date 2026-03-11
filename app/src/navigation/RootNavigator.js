import React, { useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LoadingScreen from '../components/LoadingScreen';

export default function RootNavigator() {
  const { isAuthenticated, isLoading, isSetupComplete } = useAuth();
  const navigationRef = useRef(null);

  if (isLoading) {
    return <LoadingScreen message="Starting BloomCart..." />;
  }

  return (
    <NavigationContainer ref={navigationRef}>
      {isAuthenticated ? (
        <MainNavigator navigationRef={navigationRef} />
      ) : (
        <AuthNavigator showSetup={isSetupComplete === false} />
      )}
    </NavigationContainer>
  );
}
