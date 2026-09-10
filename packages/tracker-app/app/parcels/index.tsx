import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { openAccountDialog, useOxy } from '@oxy.so/services';

import { ParcelSummaryCard } from '@/components/ParcelSummaryCard';
import { TrackingSearch } from '@/components/TrackingSearch';
import { apiErrorMessage } from '@/lib/api/client';
import { fetchMyParcels } from '@/lib/api/tracking';

/** The signed-in user's saved parcels — the only surface that needs an account. */
export default function ParcelsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthenticated, isAuthResolved } = useOxy();

  const parcels = useQuery({
    queryKey: ['tracker', 'parcels'],
    // Gated on auth being RESOLVED, not merely absent: the Oxy SDK restores a
    // returning session asynchronously, and firing this before it settles would
    // spend a guaranteed 401 and render the signed-out state to somebody who is
    // in fact signed in.
    enabled: isAuthResolved && isAuthenticated,
    queryFn: () => fetchMyParcels({ page: 1, limit: 50 }),
  });

  return (
    <>
      <Head>
        <title>Mis paquetes | Moovo Tracker</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-5 pb-16"
        contentContainerStyle={{ paddingTop: insets.top + 16 }}
      >
        <View className="mx-auto w-full max-w-2xl">
          <Link href="/" asChild>
            <Pressable accessibilityRole="button" className="self-start py-2">
              <Text className="text-sm font-semibold text-primary">← Inicio</Text>
            </Pressable>
          </Link>

          <Text className="mt-4 text-2xl font-bold text-foreground">Mis paquetes</Text>

          <View className="mt-5">
            <TrackingSearch />
          </View>

          {!isAuthResolved ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
            </View>
          ) : !isAuthenticated ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                Inicia sesión para ver tu lista
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Rastrear un paquete suelto no necesita cuenta. Guardarlos y recibir avisos, sí.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => openAccountDialog()}
                className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
              >
                <Text className="text-sm font-semibold text-primary-foreground">
                  Iniciar sesión
                </Text>
              </Pressable>
            </View>
          ) : parcels.isPending ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
            </View>
          ) : parcels.isError ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-sm text-muted-foreground">
                {apiErrorMessage(parcels.error, 'No hemos podido cargar tus paquetes.')}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => parcels.refetch()}
                className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
              >
                <Text className="text-sm font-semibold text-primary-foreground">Reintentar</Text>
              </Pressable>
            </View>
          ) : parcels.data.parcels.length === 0 ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                Todavía no sigues ningún paquete
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Pega un número de seguimiento arriba y guárdalo para recibir avisos.
              </Text>
            </View>
          ) : (
            <View className="mt-8 gap-3">
              {parcels.data.parcels.map((parcel) => (
                <ParcelSummaryCard key={parcel.id} parcel={parcel} />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </>
  );
}
