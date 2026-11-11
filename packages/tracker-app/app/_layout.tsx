import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { OxyProvider, useAccountColor, useOxy } from '@oxy.so/services/ui/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { useTheme } from '@oxy.so/bloom/theme';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';

import { ErrorBoundary as BloomErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { QueryProvider } from '@/lib/query-client';
import { setOxyServices } from '@/lib/api/client';
import { OXY_CLIENT_ID } from '@/lib/config';
import { AppSplash } from '@moovo/app-shell/components/AppSplash';
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

  setOxyServices(oxyServices);

  const resolveImageSource = useCallback(
    (fileId: string, variant?: string): string | undefined => {
      const url = oxyServices.assets.publicUrl(fileId, variant ?? 'thumb');
      return url?.startsWith('http') ? url : undefined;
    },
    [oxyServices],
  );

  return <ImageResolverProvider value={resolveImageSource}>{children}</ImageResolverProvider>;
}

function AppContent() {
  useAccountColor();
  const { colors } = useTheme();

  // Bloom holds `onFontsLoading` until its fonts are in, so by the time this mounts the app can paint.
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

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
  return (
    <BloomErrorBoundary>
      <BloomProvider
        scrollAdapter={expoRouterScrollAdapter}
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        onFontsLoading={<AppSplash />}
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
      </BloomProvider>
    </BloomErrorBoundary>
  );
}
