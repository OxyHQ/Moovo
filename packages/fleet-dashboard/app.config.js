const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');

/**
 * Moovo Hub (fleet-dashboard) Expo config.
 *
 * Migrated from the previous static `app.json` so the native splash can adopt
 * the shared Oxy family pattern via `@oxy.so/expo-splash`, whose config plugin is
 * a FUNCTION (`oxySplashScreenPlugin(...)`) and therefore can't live in a static
 * JSON `plugins` array. All non-splash config below is a faithful port of the
 * old `app.json`.
 */
module.exports = () => ({
  expo: {
    owner: 'oxyhq',
    name: 'Moovo Hub',
    slug: 'moovo-hub',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon-512.png',
    scheme: 'moovohub',
    userInterfaceStyle: 'automatic',
    // The native OS splash is now owned by `@oxy.so/expo-splash` (see `plugins`),
    // which configures `expo-splash-screen`. The old static `splash` block was
    // removed so there is a single source of truth for the native splash.
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'now.moovo.hub',
      infoPlist: {
        UIBackgroundModes: ['remote-notification'],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/icon-512-maskable.png',
        monochromeImage: './assets/adaptive-icon-monochrome.png',
        backgroundColor: '#FFFFFF',
      },
      package: 'now.moovo.hub',
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/icon-192.png',
    },
    plugins: [
      'expo-router',
      'expo-localization',
      'expo-font',
      'expo-image',
      'expo-secure-store',
      'expo-web-browser',
      'expo-asset',
      'expo-notifications',
      // Native OS splash (Oxy family "Instagram, from Meta" pattern): Moovo's own
      // logo (white on transparent) centered on the dark brand background, with
      // the shared Oxy symbol pinned to the bottom. `oxySplashScreenPlugin`
      // builds the `expo-splash-screen` tuple; the bare `@oxy.so/expo-splash`
      // entry (bundled Oxy asset) MUST immediately follow it to add the bottom
      // branding — this ordering is load-bearing.
      oxySplashScreenPlugin({
        image: './assets/images/splash-logo.png',
        imageWidth: 176,
        backgroundColor: '#0B0B0F',
      }),
      '@oxy.so/expo-splash',
      // Declares and requests the Oxy signature permissions (identity, device
      // session) and adds the <queries> for the Commons/Accounts providers, so
      // Moovo Hub, on its own Android UID, can ask Commons for the Oxy identity
      // ("sign in once, use everywhere").
      '@oxy.so/services/plugins/withOxySharedPermissions',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
    },
  },
});
