import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import Head from 'expo-router/head';

export default function NotFoundScreen() {
  return (
    <>
      <Head>
        <title>Página no encontrada | Moovo Tracker</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: 'Vaya' }} />
      <View className="flex-1 items-center justify-center bg-background p-5">
        <Text className="text-xl font-bold text-foreground">Esta página no existe.</Text>
        <Link href="/" className="mt-4 py-4">
          <Text className="text-sm text-primary">Rastrear un paquete</Text>
        </Link>
      </View>
    </>
  );
}
