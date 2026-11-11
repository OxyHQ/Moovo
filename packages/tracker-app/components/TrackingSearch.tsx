import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';

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
    <View className="w-full gap-2">
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextFieldInput
            label="Número de seguimiento"
            placeholder="Pega aquí tu número de seguimiento"
            value={value}
            onValueChange={setValue}
            onSubmitEditing={submit}
            autoFocus={autoFocus}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
        <Button
          size="lg"
          disabled={!canSubmit}
          onPress={submit}
          accessibilityLabel="Rastrear paquete"
        >
          Rastrear
        </Button>
      </View>

      <Text variant="caption-1-regular" className="px-1 text-muted-foreground">
        Correos, SEUR, DHL, GLS, UPS, FedEx, Amazon y más. No hace falta cuenta.
      </Text>
    </View>
  );
}
