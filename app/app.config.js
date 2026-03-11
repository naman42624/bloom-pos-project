/**
 * BloomCart POS — Dynamic Expo Configuration
 *
 * This file replaces static app.json for production builds.
 * Environment variables are baked in at build time via EAS.
 *
 * Usage:
 *   - Local dev:     npx expo start (uses defaults)
 *   - EAS build:     eas build --profile production (uses eas.json env vars)
 *   - OTA update:    eas update --branch production
 */

export default {
  expo: {
    name: "BloomCart POS",
    slug: "bloomcart-pos",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    splash: {
      backgroundColor: "#E91E63",
      resizeMode: "contain",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.bloomcart.pos",
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          "BloomCart needs your location for attendance geofencing and delivery tracking.",
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "BloomCart needs background location access for automatic attendance clock-in/out via geofencing and delivery partner tracking.",
        NSLocationAlwaysUsageDescription:
          "BloomCart needs background location access for automatic attendance and delivery tracking.",
        UIBackgroundModes: ["location"],
      },
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#E91E63",
      },
      package: "com.bloomcart.pos",
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_LOCATION",
      ],
    },
    web: {
      favicon: "./assets/favicon.png",
      bundler: "metro",
    },
    platforms: ["ios", "android", "web"],
    plugins: [
      "@react-native-community/datetimepicker",
      [
        "expo-notifications",
        {
          icon: "./assets/icon.png",
          color: "#E91E63",
        },
      ],
      [
        "expo-location",
        {
          locationAlwaysAndWhenInUsePermission:
            "BloomCart needs background location for automatic attendance and delivery tracking.",
          locationWhenInUsePermission:
            "BloomCart needs your location for attendance geofencing and delivery tracking.",
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
        },
      ],
    ],
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://192.168.29.160:3001/api",
      eas: {
        projectId: process.env.EAS_PROJECT_ID || "your-eas-project-id",
      },
    },
    updates: {
      url: "https://u.expo.dev/your-eas-project-id",
    },
    runtimeVersion: {
      policy: "appVersion",
    },
  },
};
