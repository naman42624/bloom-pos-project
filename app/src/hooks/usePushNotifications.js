import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function usePushNotifications(navigationRef) {
  const { user } = useAuth();
  const tokenRef = useRef(null);
  const responseListener = useRef();

  useEffect(() => {
    if (!user) return;

    const register = async () => {
      try {
        if (!Device.isDevice) return; // Push won't work on simulator

        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted') return;

        // Get Expo push token — resolve projectId from multiple sources
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          Constants.easConfig?.projectId ??
          undefined;

        const tokenData = await Notifications.getExpoPushTokenAsync({
          ...(projectId ? { projectId } : {}),
        });
        const token = tokenData.data;
        tokenRef.current = token;

        // Register with server
        await api.registerPushToken(token, Platform.OS);

        // Configure Android channel
        if (Platform.OS === 'android') {
          Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#FF231F7C',
          });
        }
      } catch (err) {
        console.log('Push registration error:', err.message);
      }
    };

    register();

    // Handle notification taps (when app is open or comes from background)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data || {};
        if (navigationRef?.current) {
          try {
            // Navigate to nested screens within tabs
            if (data.screen === 'SaleDetail' && data.saleId) {
              // SaleDetail is in DashboardStack → Dashboard tab
              navigationRef.current.navigate('Dashboard', {
                screen: 'SaleDetail',
                params: { saleId: data.saleId },
              });
            } else if (data.screen === 'DeliveryDetail' && data.deliveryId) {
              // DeliveryDetail is in DashboardStack → Dashboard tab
              navigationRef.current.navigate('Dashboard', {
                screen: 'DeliveryDetail',
                params: { deliveryId: data.deliveryId },
              });
            } else if (data.screen === 'ProductionQueue') {
              // ProductionQueue is in DashboardStack → Dashboard tab
              navigationRef.current.navigate('Dashboard', {
                screen: 'ProductionQueue',
              });
            } else if (data.screen === 'CustomerOrderDetail' && data.saleId) {
              // Customer order detail via MyOrders tab
              navigationRef.current.navigate('MyOrders', {
                screen: 'CustomerOrderDetail',
                params: { saleId: data.saleId },
              });
            }
          } catch (err) {
            console.log('Navigation error:', err.message);
          }
        }
      }
    );

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [user?.id]);

  return { token: tokenRef.current };
}
