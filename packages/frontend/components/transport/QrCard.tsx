import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';

/**
 * A labelled QR card the SENDER shows the courier to prove a leg.
 *
 * The plaintext `code` (surfaced only in the owner-scoped `JobView`) is encoded
 * as a QR for the courier to scan at pickup/delivery; the raw code is also shown
 * underneath so it can be relayed verbally as a fallback. QR is always rendered
 * on a white background (scanner contrast) regardless of theme.
 */
export function QrCard({
  title,
  code,
  size = 180,
}: {
  title: string;
  code: string;
  size?: number;
}) {
  const { colors } = useColorScheme();
  return (
    <View className="items-center gap-3 rounded-2xl border border-border bg-card p-5">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      <View className="rounded-xl bg-white p-3">
        <QRCode value={code} size={size} color="#000000" backgroundColor="#ffffff" />
      </View>
      <Text className="text-center font-mono text-xs tracking-widest text-muted-foreground" selectable>
        {code}
      </Text>
      <Text className="text-center text-xs text-muted-foreground">
        Show this to your courier to confirm the {title.toLowerCase()}.
      </Text>
      {/* `colors` is read so the card adapts to theme without inline styling of
          the QR itself (kept white for scan reliability). */}
      <View className="h-px w-full" style={{ backgroundColor: colors.border }} />
    </View>
  );
}
