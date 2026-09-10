import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery } from '@tanstack/react-query';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { toast } from '@oxy.so/bloom/toast';

import { CarrierPicker } from '@/components/CarrierPicker';
import { StatusBadge } from '@/components/StatusBadge';
import { Timeline } from '@/components/Timeline';
import { apiErrorMessage } from '@/lib/api/client';
import { detectCarrier, lookupParcel, trackParcel } from '@/lib/api/tracking';
import { queryClient } from '@/lib/query-client';
import { rememberLookup } from '@/lib/recents';
import { STATUS_HINTS, formatDate } from '@/lib/status';

/**
 * The anonymous result — one number in, one answer out.
 *
 * This is a one-off LOOKUP: no subscription row, no notification, no socket
 * room, no identity. It refreshes the shared parcel row (the cache every later
 * watcher benefits from) and costs at most one carrier call. Subscribing, from
 * the button at the bottom, is the only thing that arms the poller.
 *
 * ## Two answers, and the carrier decides which
 *
 * `carrier.pollSupported` says whether Moovo can FETCH status from that carrier
 * or only link out — it is `capabilities.fetch` off the adapter, stored on the
 * row. Today every built-in adapter is deep-link-only, so this screen must not
 * promise a timeline it cannot produce; when a carrier gains a feed the row
 * flips and the timeline branch starts rendering with no change here.
 *
 * The path is `/track/[number]` and not `/t/[number]` because the backend's own
 * `moovo` deep-link template already spells it that way
 * (`adapters/built-in-carriers.ts`). One spelling of the tracker's URL.
 */
export default function TrackScreen() {
  const { number, carrier: carrierParam } = useLocalSearchParams<{
    number: string;
    carrier?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useOxy();

  const hasNumber = typeof number === 'string' && number.length > 0;

  // Detection first, and it is FREE: it reads the catalogue and the check
  // digits, and calls no carrier. Skipped entirely once a carrier is pinned in
  // the URL, which is what a picker selection writes.
  const detect = useQuery({
    queryKey: ['tracker', 'detect', number],
    enabled: hasNumber && !carrierParam,
    queryFn: () => detectCarrier(number),
  });

  const carrierKey = carrierParam ?? detect.data?.carrierKey ?? undefined;
  // Detection ran and could not decide. SEUR, GLS and Amazon have no detection
  // rule at all (their references collide with too much else), so this is the
  // ordinary path for them rather than an edge case — without a picker those
  // carriers are simply unreachable.
  const needsCarrier = !carrierParam && detect.isSuccess && !detect.data.carrierKey;

  const lookup = useQuery({
    queryKey: ['tracker', 'lookup', number, carrierKey],
    enabled: hasNumber && Boolean(carrierKey),
    queryFn: async () => {
      const result = await lookupParcel({ number, carrierKey });

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
        // A carrier Moovo cannot fetch from will never produce a state change,
        // so asking to be notified about one would be a promise nothing can
        // keep. The parcel is still worth saving: it stays in the list, one tap
        // from the carrier's own page.
        notify: lookup.data?.carrier.pollSupported ?? false,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracker', 'parcels'] });
      toast.success('Guardado en tus paquetes.');
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'No se ha podido guardar el paquete.'));
    },
  });

  const parcel = lookup.data;
  const eta = formatDate(parcel?.estimatedDeliveryAt);
  const delivered = formatDate(parcel?.deliveredAt);
  const isPending = detect.isPending || (Boolean(carrierKey) && lookup.isPending);
  const error = detect.error ?? lookup.error;

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

          <Text className="mt-4 text-xs font-semibold uppercase text-muted-foreground">
            Número de seguimiento
          </Text>
          <Text className="mt-1 text-2xl font-bold text-foreground" selectable>
            {parcel?.trackingNumber ?? number}
          </Text>

          {needsCarrier ? (
            <CarrierPicker
              candidates={detect.data.candidates}
              onSelect={(key) =>
                router.replace({
                  pathname: '/track/[number]',
                  params: { number, carrier: key },
                })
              }
            />
          ) : isPending ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
              <Text className="mt-3 text-sm text-muted-foreground">Identificando el envío…</Text>
            </View>
          ) : error ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                No hemos podido consultar este envío
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {apiErrorMessage(error, 'Revisa el número e inténtalo de nuevo en unos minutos.')}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  router.replace({ pathname: '/track/[number]', params: { number } })
                }
                className="mt-4 h-11 items-center justify-center rounded-xl bg-primary px-5"
              >
                <Text className="text-sm font-semibold text-primary-foreground">
                  Elegir transportista
                </Text>
              </Pressable>
            </View>
          ) : parcel ? (
            <>
              <Text className="mt-4 text-base font-semibold text-foreground">
                {parcel.carrier.name}
              </Text>

              {parcel.carrier.pollSupported ? (
                <>
                  <StatusBadge status={parcel.status} className="mt-3" />
                  <Text className="mt-3 text-sm text-muted-foreground">
                    {STATUS_HINTS[parcel.status]}
                  </Text>

                  {delivered ? (
                    <Text className="mt-3 text-sm text-foreground">Entregado el {delivered}</Text>
                  ) : eta ? (
                    <Text className="mt-3 text-sm text-foreground">Entrega prevista: {eta}</Text>
                  ) : null}

                  <View className="mt-6">
                    <Text className="mb-3 text-sm font-semibold text-foreground">Movimientos</Text>
                    <Timeline checkpoints={parcel.checkpoints} />
                  </View>
                </>
              ) : (
                // The honest answer for a carrier Moovo can only link out to.
                // Saying "sin movimientos todavía" here would blame the carrier
                // for something Moovo has not built.
                <View className="mt-4 rounded-2xl border border-border bg-card p-5">
                  <Text className="text-base font-semibold text-foreground">
                    Hemos identificado el transportista
                  </Text>
                  <Text className="mt-1 text-sm text-muted-foreground">
                    Moovo todavía no recibe el estado de {parcel.carrier.name}, así que el
                    recorrido lo tiene su web. Te llevamos directo a la página de este envío.
                  </Text>
                </View>
              )}

              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Abrir el seguimiento en la web de ${parcel.carrier.name}`}
                onPress={() => Linking.openURL(parcel.trackingUrl)}
                className={
                  parcel.carrier.pollSupported
                    ? 'mt-4 h-11 items-center justify-center rounded-xl border border-border px-5'
                    : 'mt-4 h-12 items-center justify-center rounded-xl bg-primary px-5'
                }
              >
                <Text
                  className={
                    parcel.carrier.pollSupported
                      ? 'text-sm font-semibold text-foreground'
                      : 'text-sm font-semibold text-primary-foreground'
                  }
                >
                  Ver el seguimiento en {parcel.carrier.name}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  router.replace({ pathname: '/track/[number]', params: { number } })
                }
                className="mt-2 h-11 items-center justify-center rounded-xl px-5"
              >
                <Text className="text-sm text-muted-foreground">
                  ¿No es {parcel.carrier.name}? Elegir otro transportista
                </Text>
              </Pressable>

              <View className="mt-8 rounded-2xl border border-border bg-card p-5">
                <Text className="text-base font-semibold text-foreground">Guárdalo en tu lista</Text>
                <Text className="mt-1 text-sm text-muted-foreground">
                  {!isAuthenticated
                    ? 'Inicia sesión para tener todos tus envíos en una sola lista.'
                    : parcel.carrier.pollSupported
                      ? 'Lo guardamos en tu lista y te avisamos en cada cambio de estado.'
                      : 'Lo guardamos en tu lista, a un toque de la web del transportista. Los avisos llegarán cuando Moovo reciba el estado de este transportista.'}
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
                        : 'Iniciar sesión para guardarlo'}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
