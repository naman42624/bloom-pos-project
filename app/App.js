import React, { useState } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';
import TrackingScreen from './src/screens/TrackingScreen';
import SlipScreen from './src/screens/SlipScreen';
import OrderRequestScreen from './src/screens/OrderRequestScreen';
import PricePageScreen from './src/screens/PricePageScreen';
import JoinScreen from './src/screens/JoinScreen';

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

// Web-only, same reasoning as getTrackingToken above: a customer opens this
// link from a WhatsApp message shared by staff (see CustomerDetailScreen's
// "Copy Order Link"/WhatsApp buttons), never inside the staff app itself.
function getOrderRequestRoute() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const path = window.location.pathname;
  if (/^\/order-request\/open\/?$/.test(path)) return { mode: 'open' };
  const status = /^\/order-request\/status\/([0-9a-f]{48})\/?$/.exec(path);
  return status ? { statusToken: status[1] } : null;
}

function getOrderRequestToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/order-request\/([^/]+)$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

// Web-only, same reasoning: someone scans the QR on a printed slip and lands
// here with no login. Checked first.
function getSlipToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/slip\/([^/]+)$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

// Web-only: a customer scans the QR on a product label and lands here with no
// login. Code alphabet excludes I, O, 0, 1.
function getPriceCode() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/p\/([A-Z0-9]{8})\/?$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

// Web-only: a helper opens the owner's one-time join link on their own phone
// (spec §8.3). Unlike the pages above it needs AuthProvider (setting the PIN
// signs them in), but not RootNavigator.
function getJoinToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/join\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

export default function App() {
  const [joinToken, setJoinToken] = useState(getJoinToken);

  const priceCode = getPriceCode();
  if (priceCode) {
    return <PricePageScreen code={priceCode} />;
  }

  const slipToken = getSlipToken();
  if (slipToken) {
    return <SlipScreen token={slipToken} />;
  }

  const trackingToken = getTrackingToken();
  if (trackingToken) {
    return <TrackingScreen token={trackingToken} />;
  }

  // Open link and status page BEFORE the per-customer regex, or "open" and
  // "status" would be read as a customer token.
  const orderRequestRoute = getOrderRequestRoute();
  if (orderRequestRoute) {
    return <OrderRequestScreen {...orderRequestRoute} />;
  }

  const orderRequestToken = getOrderRequestToken();
  if (orderRequestToken) {
    return <OrderRequestScreen token={orderRequestToken} />;
  }

  // After the PIN is set, leave the join URL so a reload opens the app (the
  // helper's lock screen), not a used link.
  const onJoined = () => {
    try { window.history.replaceState(null, '', '/'); } catch { /* not a browser */ }
    setJoinToken(null);
  };

  return (
    <SafeAreaProvider>
      <AuthProvider>
        {joinToken ? <JoinScreen token={joinToken} onJoined={onJoined} /> : <RootNavigator />}
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
