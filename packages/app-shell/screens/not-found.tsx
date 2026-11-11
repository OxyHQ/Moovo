import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { EmptyState } from '@oxy.so/bloom/empty-state';

export default function NotFoundScreen() {
  const router = useRouter();
  return (
    <>
      <Head>
        <title>404 - Page Not Found | Moovo</title>
        <meta
          name="description"
          content="The page you're looking for doesn't exist. Return to Moovo to keep browsing."
        />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <View className="flex-1 items-center justify-center bg-background p-5">
        <EmptyState
          title="This screen doesn't exist."
          action={{ label: 'Go to home screen', onPress: () => router.replace('/') }}
        />
      </View>
    </>
  );
}
