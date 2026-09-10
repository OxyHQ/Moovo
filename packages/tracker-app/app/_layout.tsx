import { useCallback } from 'react';
import { Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { OxyProvider, useOxy } from '@oxy.so/services';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';

import { AppErrorBoundary } from '@/components/error-boundary';
import { QueryProvider } from '@/lib/query-client';
import { setTokenGetter } from '@/lib/api/client';
import { OXY_CLIENT_ID } from '@/lib/config';
import { useColorScheme } from '@/lib/useColorScheme';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
import 'react-native-reanimated';
import '../global.css';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  setTokenGetter(() => oxyServices.getAccessToken() || null);

  const resolveImageSource = useCallback(
    (fileId: string, variant?: string): string | undefined => {
      const url = oxyServices.getFileDownloadUrl(fileId, variant ?? 'thumb');
      return url && url.startsWith('http') ? url : undefined;
    },
    [oxyServices],
  );

  return <ImageResolverProvider value={resolveImageSource}>{children}</ImageResolverProvider>;
}

function AppContent() {
  const { colors } = useColorScheme();

  return (
    <AuthSetup>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </AuthSetup>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Thrown during render so the error boundary above renders the failure,
  // rather than the app sitting on a splash screen that never resolves.
  if (error) throw error;

  // `onLayout` rather than an effect: the splash must be hidden once the first
  // real frame has been laid out, which is exactly what this callback reports.
  const onLayoutRootView = useCallback(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <View style={{ flex: 1 }} onLayout={onLayoutRootView}>
        <BloomThemeProvider
          defaultMode="system"
          defaultColorPreset="blue"
          persistKey={BLOOM_THEME_PERSIST_KEY}
          storage={BLOOM_THEME_STORAGE}
          fonts={false}
        >
          <OxyProvider
            baseURL={OXY_API_URL}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
            // Moovo Tracker opens on a PUBLIC landing and stays usable signed
            // out: pasting a number and reading the timeline never needs an
            // account. Sign-in only buys a saved list and notifications, so the
            // SDK cold boot restores a returning user silently without
            // redirecting a stranger to auth.
          >
            <QueryProvider>
              <AppContent />
            </QueryProvider>
          </OxyProvider>
        </BloomThemeProvider>
      </View>
    </AppErrorBoundary>
  );
}
