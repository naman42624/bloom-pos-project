import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LoadingScreen from '../components/LoadingScreen';

export default function RootNavigator() {
  const { isAuthenticated, isLoading, isSetupComplete } = useAuth();

  if (isLoading) {
    return <LoadingScreen message="Starting BloomCart..." />;
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? (
        <MainNavigator />
      ) : (
        <AuthNavigator showSetup={isSetupComplete === false} />
      )}
    </NavigationContainer>
  );
}
