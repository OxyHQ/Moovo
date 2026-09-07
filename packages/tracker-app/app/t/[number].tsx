import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery } from '@tanstack/react-query';
import { openAccountDialog, useOxy } from '@oxyhq/services';
import { toast } from '@oxyhq/bloom/toast';

import { StatusBadge } from '@/components/StatusBadge';
import { Timeline } from '@/components/Timeline';
import { apiErrorMessage } from '@/lib/api/client';
import { lookupParcel, trackParcel } from '@/lib/api/tracking';
import { queryClient } from '@/lib/query-client';
import { rememberLookup } from '@/lib/recents';
import { STATUS_HINTS, STATUS_LABELS, formatDate } from '@/lib/status';

/**
 * The anonymous result — one number in, one timeline out.
 *
 * This is a one-off LOOKUP: no subscription row, no notification, no socket
 * room, no identity. It refreshes the shared parcel row (the cache every later
 * watcher benefits from) and costs exactly one carrier call. Subscribing, from
 * the button at the bottom, is the only thing that arms the poller.
 */
export default function LookupScreen() {
  const { number } = useLocalSearchParams<{ number: string }>();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useOxy();

  const lookup = useQuery({
    queryKey: ['tracker', 'lookup', number],
    enabled: typeof number === 'string' && number.length > 0,
    queryFn: async () => {
      const result = await lookupParcel({ number });

      // Recorded HERE rather than in an effect, and with the number the SERVER
      // returned: that is the canonical, normalised spelling, so the device
      // list dedupes on the same identity the unique index is built on.
      await rememberLookup({
        trackingNumber: result.trackingNumber,
        carrierKey: result.carrier.key,
        carrierName: result.carrier.name,
      });
      queryClient.invalidateQueries({ queryKey: ['tracker', 'recents'] });

      return result;
    },
  });

  const save = useMutation({
    mutationFn: () =>
      trackParcel({
        number: lookup.data?.trackingNumber ?? number,
        carrierKey: lookup.data?.carrier.key,
        notify: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracker', 'parcels'] });
      toast.success('Guardado en tus paquetes. Te avisaremos cuando cambie de estado.');
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'No se ha podido guardar el paquete.'));
    },
  });

  const parcel = lookup.data;
  const eta = formatDate(parcel?.estimatedDeliveryAt);
  const delivered = formatDate(parcel?.deliveredAt);

  return (
    <>
      <Head>
        <title>{`Seguimiento ${number} | Moovo Tracker`}</title>
        {/* One visitor's parcel. Nothing here belongs in a search index. */}
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
              <Text className="text-sm font-semibold text-primary">← Rastrear otro paquete</Text>
            </Pressable>
          </Link>

          {lookup.isPending ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
              <Text className="mt-3 text-sm text-muted-foreground">
                Consultando al transportista…
              </Text>
            </View>
          ) : lookup.isError ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                No hemos podido consultar este envío
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {apiErrorMessage(
                  lookup.error,
                  'Revisa el número e inténtalo de nuevo en unos minutos.',
                )}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => lookup.refetch()}
                className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
              >
                <Text className="text-sm font-semibold text-primary-foreground">Reintentar</Text>
              </Pressable>
            </View>
          ) : parcel ? (
            <>
              <View className="mt-6">
                <Text className="text-xs font-semibold uppercase text-muted-foreground">
                  {parcel.carrier.name}
                </Text>
                <Text className="mt-1 text-2xl font-bold text-foreground" selectable>
                  {parcel.trackingNumber}
                </Text>
                <StatusBadge status={parcel.status} className="mt-3" />
                <Text className="mt-3 text-sm text-muted-foreground">
                  {STATUS_HINTS[parcel.status]}
                </Text>

                {delivered ? (
                  <Text className="mt-3 text-sm text-foreground">Entregado el {delivered}</Text>
                ) : eta ? (
                  <Text className="mt-3 text-sm text-foreground">Entrega prevista: {eta}</Text>
                ) : null}
              </View>

              <View className="mt-6">
                <Text className="mb-3 text-sm font-semibold text-foreground">Movimientos</Text>
                <Timeline checkpoints={parcel.checkpoints} />
              </View>

              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Abrir el seguimiento en la web de ${parcel.carrier.name}`}
                onPress={() => Linking.openURL(parcel.trackingUrl)}
                className="mt-4 h-11 items-center justify-center rounded-xl border border-border px-5"
              >
                <Text className="text-sm font-semibold text-foreground">
                  Ver en la web de {parcel.carrier.name}
                </Text>
              </Pressable>

              <View className="mt-8 rounded-2xl border border-border bg-card p-5">
                <Text className="text-base font-semibold text-foreground">
                  Sigue este paquete
                </Text>
                <Text className="mt-1 text-sm text-muted-foreground">
                  {isAuthenticated
                    ? 'Lo guardamos en tu lista y te avisamos en cada cambio de estado.'
                    : 'Inicia sesión para guardarlo en tu lista y recibir avisos cuando cambie de estado.'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={save.isPending}
                  onPress={() => (isAuthenticated ? save.mutate() : openAccountDialog())}
                  className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
                >
                  <Text className="text-sm font-semibold text-primary-foreground">
                    {save.isPending
                      ? 'Guardando…'
                      : isAuthenticated
                        ? 'Guardar en mis paquetes'
                        : 'Iniciar sesión para seguirlo'}
                  </Text>
                </Pressable>
              </View>

              <Text className="mt-6 text-xs text-muted-foreground">
                Estado facilitado por {parcel.carrier.name}. Moovo muestra el recorrido del
                paquete; los datos del destinatario nunca salen del transportista.
              </Text>
            </>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
