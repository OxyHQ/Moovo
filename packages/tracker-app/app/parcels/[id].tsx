import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery } from '@tanstack/react-query';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { toast } from '@oxy.so/bloom/toast';

import { StatusBadge } from '@/components/StatusBadge';
import { Timeline } from '@/components/Timeline';
import { apiErrorMessage } from '@/lib/api/client';
import { fetchParcel, refreshParcel, untrackParcel, updateParcel } from '@/lib/api/tracking';
import { queryClient } from '@/lib/query-client';
import {
  JOB_STATUS_LABELS,
  STATUS_HINTS,
  formatCheckpointTime,
  formatDate,
} from '@/lib/status';

/**
 * One saved parcel.
 *
 * The `:id` is the SUBSCRIPTION's id, never the shared parcel's — the parcel row
 * is shared by everyone tracking that number, so its id is never exposed.
 *
 * The response is discriminated by where the timeline comes from. A Moovo
 * delivery is a POINTER, never a copy: it carries zero checkpoints for its whole
 * life and is hydrated from the JOB instead, which is what keeps `job_status_events`
 * with exactly one writer.
 */
export default function ParcelDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [refreshRequested, setRefreshRequested] = useState(false);
  const { isAuthenticated, isAuthResolved } = useOxy();

  const detail = useQuery({
    queryKey: ['tracker', 'parcels', id],
    // Gated on auth being RESOLVED, exactly as the list is. The Oxy SDK restores
    // a returning session asynchronously, and this screen is the one people open
    // from a cold start via a link — firing before the session settles spends a
    // guaranteed 401 and caches it as the answer.
    enabled: typeof id === 'string' && id.length > 0 && isAuthResolved && isAuthenticated,
    queryFn: () => fetchParcel(id),
  });

  const parcel = detail.data?.parcel;

  const refresh = useMutation({
    mutationFn: () => refreshParcel(id),
    onSuccess: () => {
      // The endpoint answers 202 and never calls the carrier inline, so the new
      // checkpoints arrive on a LATER read. Saying "actualizado" here would be a
      // lie; this says what actually happened.
      setRefreshRequested(true);
      toast.success('Consulta pedida al transportista. Los movimientos llegarán en breve.');
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'No se ha podido pedir la actualización.'));
    },
  });

  const setNotify = useMutation({
    mutationFn: (notify: boolean) => updateParcel(id, { notify }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['tracker', 'parcels', id], (previous: typeof detail.data) =>
        previous ? { ...previous, parcel: updated } : previous,
      );
      queryClient.invalidateQueries({ queryKey: ['tracker', 'parcels'] });
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'No se ha podido cambiar el aviso.'));
    },
  });

  const remove = useMutation({
    mutationFn: () => untrackParcel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracker', 'parcels'] });
      toast.success('Paquete eliminado de tu lista.');
      router.replace('/parcels');
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'No se ha podido eliminar el paquete.'));
    },
  });

  const eta = formatDate(parcel?.estimatedDeliveryAt);
  const delivered = formatDate(parcel?.deliveredAt);

  return (
    <>
      <Head>
        <title>{parcel ? `${parcel.trackingNumber} | Moovo Tracker` : 'Moovo Tracker'}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-5 pb-16"
        contentContainerStyle={{ paddingTop: insets.top + 16 }}
      >
        <View className="mx-auto w-full max-w-2xl">
          <Link href="/parcels" asChild>
            <Pressable accessibilityRole="button" className="self-start py-2">
              <Text className="text-sm font-semibold text-primary">← Mis paquetes</Text>
            </Pressable>
          </Link>

          {!isAuthResolved ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
            </View>
          ) : !isAuthenticated ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-base font-semibold text-foreground">
                Inicia sesión para ver este paquete
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Los paquetes guardados pertenecen a una cuenta.
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
          ) : detail.isPending ? (
            <View className="mt-16 items-center">
              <ActivityIndicator />
            </View>
          ) : detail.isError ? (
            <View className="mt-8 rounded-2xl border border-border bg-card p-5">
              <Text className="text-sm text-muted-foreground">
                {apiErrorMessage(detail.error, 'No hemos podido cargar este paquete.')}
              </Text>
            </View>
          ) : detail.data && parcel ? (
            <>
              <View className="mt-6">
                <Text className="text-xs font-semibold uppercase text-muted-foreground">
                  {parcel.carrier.name}
                </Text>
                <Text className="mt-1 text-2xl font-bold text-foreground">
                  {parcel.title ?? parcel.trackingNumber}
                </Text>
                {parcel.title ? (
                  <Text className="mt-0.5 text-sm text-muted-foreground" selectable>
                    {parcel.trackingNumber}
                  </Text>
                ) : null}

                {/* A deep-link-only carrier leaves `status` at `pending` for
                    the parcel's whole life, and "todavía no hemos podido
                    consultar este envío" reads as a transient failure rather
                    than a capability Moovo has not built. A Moovo job is always
                    shown: its status is projected from the job and is real. */}
                {detail.data.source === 'moovo_job' || parcel.carrier.pollSupported ? (
                  <>
                    <StatusBadge status={parcel.status} className="mt-3" />
                    <Text className="mt-3 text-sm text-muted-foreground">
                      {STATUS_HINTS[parcel.status]}
                    </Text>
                  </>
                ) : null}

                {delivered ? (
                  <Text className="mt-3 text-sm text-foreground">Entregado el {delivered}</Text>
                ) : eta ? (
                  <Text className="mt-3 text-sm text-foreground">Entrega prevista: {eta}</Text>
                ) : null}
              </View>

              {detail.data.source === 'moovo_job' ? (
                <View className="mt-6">
                  <Text className="mb-3 text-sm font-semibold text-foreground">
                    Envío de Moovo · {detail.data.job.jobNumber}
                  </Text>
                  <View className="rounded-2xl border border-border bg-card p-5">
                    {detail.data.job.statusHistory
                      .slice()
                      .reverse()
                      .map((event) => (
                        <View key={`${event.status}-${event.at}`} className="flex-row gap-3 pb-4">
                          <View className="mt-1.5 h-3 w-3 rounded-full bg-primary" />
                          <View className="flex-1">
                            <Text className="text-sm font-semibold text-foreground">
                              {JOB_STATUS_LABELS[event.status]}
                            </Text>
                            <Text className="mt-0.5 text-xs text-muted-foreground">
                              {formatCheckpointTime(event.at, false)}
                            </Text>
                          </View>
                        </View>
                      ))}
                  </View>
                </View>
              ) : (
                <View className="mt-6">
                  {parcel.carrier.pollSupported ? (
                    <>
                      <Text className="mb-3 text-sm font-semibold text-foreground">
                        Movimientos
                      </Text>
                      <Timeline checkpoints={detail.data.checkpoints} />
                      {refreshRequested ? (
                        <Text className="mt-2 px-1 text-xs text-muted-foreground">
                          Hemos pedido una consulta al transportista. Vuelve a abrir esta
                          pantalla en unos minutos para ver los movimientos nuevos.
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    // Same argument as on the public track screen: an empty
                    // timeline for a deep-link-only carrier is Moovo's gap, not
                    // the carrier's silence, and must not be dressed as one.
                    <View className="rounded-2xl border border-border bg-card p-5">
                      <Text className="text-sm text-muted-foreground">
                        Moovo todavía no recibe el estado de {parcel.carrier.name}. El recorrido
                        de este envío está en su web.
                      </Text>
                    </View>
                  )}
                </View>
              )}

              <View className="mt-6 gap-3">
                {detail.data.source === 'carrier' && parcel.carrier.pollSupported ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={refresh.isPending}
                    onPress={() => refresh.mutate()}
                    className="h-11 items-center justify-center rounded-xl border border-border px-5"
                  >
                    <Text className="text-sm font-semibold text-foreground">
                      {refresh.isPending ? 'Pidiendo…' : 'Actualizar ahora'}
                    </Text>
                  </Pressable>
                ) : null}

                <Pressable
                  accessibilityRole="link"
                  onPress={() => Linking.openURL(parcel.trackingUrl)}
                  className="h-11 items-center justify-center rounded-xl border border-border px-5"
                >
                  <Text className="text-sm font-semibold text-foreground">
                    Ver en la web de {parcel.carrier.name}
                  </Text>
                </Pressable>
              </View>

              <View className="mt-6 flex-row items-center justify-between rounded-2xl border border-border bg-card p-5">
                <View className="flex-1 pr-4">
                  <Text className="text-sm font-semibold text-foreground">
                    Avisarme de los cambios
                  </Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">
                    {parcel.carrier.pollSupported
                      ? 'Te escribimos cuando el paquete cambia de estado.'
                      : `Moovo todavía no recibe el estado de ${parcel.carrier.name}, así que no hay cambios que avisar.`}
                  </Text>
                </View>
                <Switch
                  value={parcel.notifyOnStateChange}
                  // A carrier with no feed produces no state change, so leaving
                  // this switchable would store a preference nothing can honour.
                  disabled={setNotify.isPending || !parcel.carrier.pollSupported}
                  onValueChange={(value) => setNotify.mutate(value)}
                  accessibilityLabel="Avisarme de los cambios de estado"
                />
              </View>

              <Pressable
                accessibilityRole="button"
                disabled={remove.isPending}
                onPress={() => remove.mutate()}
                className="mt-6 h-11 items-center justify-center rounded-xl px-5"
              >
                <Text className="text-sm font-semibold text-red-600 dark:text-red-400">
                  {remove.isPending ? 'Eliminando…' : 'Dejar de seguir este paquete'}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
