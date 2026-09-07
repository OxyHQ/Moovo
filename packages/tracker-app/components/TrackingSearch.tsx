import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { cn } from '@/lib/utils';

/**
 * The paste box — the top of the funnel.
 *
 * The raw string the visitor pasted is what travels: the SERVER normalises it
 * (`normalizeTrackingNumber`), and there is exactly one spelling of that rule.
 * Re-implementing it here to pretty up the URL would create a second one, and a
 * client and server that disagree about what "the same number" means is how the
 * dedupe that makes a parcel cost one carrier call quietly stops holding.
 */
export function TrackingSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState('');

  const trimmed = value.trim();
  const canSubmit = trimmed.length >= 4;

  const submit = () => {
    if (!canSubmit) return;
    router.push(`/track/${encodeURIComponent(trimmed)}`);
  };

  return (
    <View className="w-full">
      <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-card p-2">
        <TextInput
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          autoFocus={autoFocus}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          placeholder="Pega aquí tu número de seguimiento"
          accessibilityLabel="Número de seguimiento"
          className="h-12 flex-1 px-3 text-base text-foreground"
          placeholderTextColor="rgb(148 163 184)"
        />
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Rastrear paquete"
          className={cn(
            'h-12 items-center justify-center rounded-xl px-5',
            canSubmit ? 'bg-primary' : 'bg-muted',
          )}
        >
          <Text
            className={cn(
              'text-sm font-semibold',
              canSubmit ? 'text-primary-foreground' : 'text-muted-foreground',
            )}
          >
            Rastrear
          </Text>
        </Pressable>
      </View>

      <Text className="mt-2 px-1 text-xs text-muted-foreground">
        Correos, SEUR, DHL, GLS, UPS, FedEx, Amazon y más. No hace falta cuenta.
      </Text>
    </View>
  );
}
