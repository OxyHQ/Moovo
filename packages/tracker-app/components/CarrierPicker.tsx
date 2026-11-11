import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import type { CarrierGuess } from '@moovo/shared-types';

import { fetchCarriers } from '@/lib/api/tracking';

/**
 * Which carrier is this number from?
 *
 * Shown when detection cannot decide — which is the ORDINARY path, not an edge
 * case: SEUR, GLS and Amazon carry no detection rule at all, because their
 * references collide with too much else and a rule that fires on everything is
 * worse than none (it would make every number ambiguous). Without this screen
 * those carriers are unreachable however loudly the landing page lists them.
 *
 * The detector's own candidates come first when it produced any — it ranked
 * them and a checksum match is a real signal — with the full catalogue below.
 */
export function CarrierPicker({
  candidates,
  onSelect,
}: {
  candidates: CarrierGuess[];
  onSelect: (carrierKey: string) => void;
}) {
  const carriers = useQuery({
    queryKey: ['tracker', 'carriers'],
    // The catalogue is an operator-edited table, not per-request data.
    staleTime: 1000 * 60 * 60,
    queryFn: fetchCarriers,
  });

  const candidateKeys = new Set(candidates.map((candidate) => candidate.carrierKey));
  // `moovo` needs no filtering here: it is the INTERNAL pointer key, and the
  // server both leaves it out of `/tracking/carriers` and REFUSES it as a
  // `carrierKey` on lookup, subscribe and re-point. Re-filtering it client-side
  // would put the rule in two places and leave the weaker one looking sufficient.
  const rest = (carriers.data ?? []).filter((carrier) => !candidateKeys.has(carrier.key));

  return (
    <View className="mt-6">
      <Text className="text-base font-semibold text-foreground">
        ¿De qué transportista es este envío?
      </Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        {candidates.length > 0
          ? 'Este número puede ser de más de uno. Elige el correcto.'
          : 'No hemos podido deducirlo a partir del número. Elígelo tú.'}
      </Text>

      {candidates.length > 0 ? (
        <View className="mt-4 gap-2">
          {candidates.map((candidate) => (
            <Item
              key={candidate.carrierKey}
              title={candidate.name}
              trailing={
                candidate.checksumPassed ? (
                  <Text variant="caption-1-semibold" className="text-primary">
                    Coincide
                  </Text>
                ) : null
              }
              onPress={() => onSelect(candidate.carrierKey)}
            />
          ))}
        </View>
      ) : null}

      {carriers.isPending ? (
        <View className="mt-6 items-center">
          <Loading variant="spinner" />
        </View>
      ) : (
        <View className="mt-6 gap-2">
          {candidates.length > 0 ? (
            <Text variant="caption-1-semibold" className="mb-1 uppercase text-muted-foreground">
              Todos los transportistas
            </Text>
          ) : null}
          {rest.map((carrier) => (
            <Item key={carrier.key} title={carrier.name} onPress={() => onSelect(carrier.key)} />
          ))}
        </View>
      )}
    </View>
  );
}
