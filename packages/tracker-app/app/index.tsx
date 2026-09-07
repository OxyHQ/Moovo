import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { openAccountDialog, useOxy } from '@oxyhq/services';

import { TrackingSearch } from '@/components/TrackingSearch';
import { readRecents } from '@/lib/recents';

/**
 * The landing — and the top of Moovo's funnel.
 *
 * It works completely signed out, because that is the product: paste a number,
 * read the timeline, owe us nothing. Signing in is offered for what it actually
 * buys (a saved list and notifications), never as a wall in front of the answer.
 */
export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useOxy();

  // The signed-out visitor's recent numbers live on THEIR DEVICE — an anonymous
  // lookup persists nothing per person, by design. React Query owns the read so
  // the async storage never has to be read from a memoized position.
  const { data: recents = [] } = useQuery({
    queryKey: ['tracker', 'recents'],
    queryFn: readRecents,
    staleTime: 0,
  });

  return (
    <>
      <Head>
        <title>Rastrear paquete — seguimiento de envíos | Moovo Tracker</title>
        <meta
          name="description"
          content="Pega tu número de seguimiento y Moovo detecta el transportista y te muestra dónde está tu paquete. Correos, SEUR, DHL, GLS, UPS, FedEx y cientos más."
        />
      </Head>

      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-5 pb-16"
        contentContainerStyle={{ paddingTop: insets.top + 24 }}
      >
        <View className="mx-auto w-full max-w-2xl">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-muted-foreground">Moovo Tracker</Text>
            {isAuthenticated ? (
              <Link href="/parcels" asChild>
                <Pressable accessibilityRole="button" className="rounded-full px-3 py-2">
                  <Text className="text-sm font-semibold text-primary">Mis paquetes</Text>
                </Pressable>
              </Link>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => openAccountDialog()}
                className="rounded-full px-3 py-2"
              >
                <Text className="text-sm font-semibold text-primary">Iniciar sesión</Text>
              </Pressable>
            )}
          </View>

          <Text className="mt-10 text-3xl font-bold text-foreground">
            Rastrea tu paquete
          </Text>
          <Text className="mt-2 text-base text-muted-foreground">
            Pega el número de seguimiento. Detectamos el transportista y te mostramos dónde
            está tu envío, en una sola línea de tiempo.
          </Text>

          <View className="mt-6">
            <TrackingSearch autoFocus />
          </View>

          {recents.length > 0 ? (
            <View className="mt-10">
              <Text className="text-sm font-semibold text-foreground">Consultas recientes</Text>
              <View className="mt-3 gap-2">
                {recents.map((recent) => (
                  <Pressable
                    key={recent.trackingNumber}
                    accessibilityRole="button"
                    accessibilityLabel={`Ver ${recent.trackingNumber} de ${recent.carrierName}`}
                    onPress={() => router.push(`/t/${encodeURIComponent(recent.trackingNumber)}`)}
                    className="rounded-2xl border border-border bg-card p-4 active:opacity-70"
                  >
                    <Text className="text-sm font-semibold text-foreground">
                      {recent.trackingNumber}
                    </Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {recent.carrierName}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text className="mt-3 text-xs text-muted-foreground">
                Estas consultas se guardan solo en este dispositivo.
              </Text>
            </View>
          ) : null}

          {!isAuthenticated ? (
            <View className="mt-10 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                ¿Sigues varios paquetes?
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Con una cuenta de Oxy guardas tus envíos y te avisamos cuando cambian de
                estado. Rastrear sigue siendo gratis y sin cuenta.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => openAccountDialog()}
                className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
              >
                <Text className="text-sm font-semibold text-primary-foreground">
                  Crear cuenta o iniciar sesión
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
