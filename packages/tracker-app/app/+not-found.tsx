import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { EmptyState } from '@oxy.so/bloom/empty-state';

export default function NotFoundScreen() {
  const router = useRouter();
  return (
    <>
      <Head>
        <title>Página no encontrada | Moovo Tracker</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: 'Vaya' }} />
      <View className="flex-1 items-center justify-center bg-background p-5">
        <EmptyState
          title="Esta página no existe."
          action={{ label: 'Rastrear un paquete', onPress: () => router.replace('/') }}
        />
      </View>
    </>
  );
}
