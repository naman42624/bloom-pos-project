import React from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';
import TrackingScreen from './src/screens/TrackingScreen';

// Web-only: a customer opens this link from a WhatsApp message in their
// phone's browser, never inside the staff app itself (which has no
// comparable native deep link registered and doesn't need one). Checked
// BEFORE AuthProvider/RootNavigator ever mount — see
// docs/superpowers/specs/2026-09-11-customer-tracking-page-design.md §3 for
// why this is a full bypass rather than a route threaded through React
// Navigation's own linking config: this guarantees zero shared state with
// the authenticated app, not just "the login screen doesn't show."
function getTrackingToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/track\/([^/]+)$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

export default function App() {
  const trackingToken = getTrackingToken();
  if (trackingToken) {
    return <TrackingScreen token={trackingToken} />;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
