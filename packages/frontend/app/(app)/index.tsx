import { View, ScrollView, Platform } from "react-native";
import Head from "expo-router/head";
import { Text } from "@/components/ui/text";
import { HeroSearch } from "@/components/shell/HeroSearch";
import { Footer } from "@/components/shell/Footer";
import { useColorScheme } from "@/lib/useColorScheme";

/** Spread (px) of the gutter-color mask around the rounded frame. Paints a ring
 *  of the gutter color over any content bleeding into the thin gutter + corners. */
const GUTTER_MASK_SPREAD = 40;

/**
 * The home content shell. The marketplace product feed has been removed; this is
 * a neutral placeholder rebuilt with the Moovo courier/transport home in a later
 * phase. The branding header (`HeroSearch`) and footer are kept as scaffolding.
 */
function HomeBody() {
  return (
    <>
      <HeroSearch />

      <View className="items-center px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Welcome to Moovo.
        </Text>
      </View>

      <Footer />
    </>
  );
}

export default function HomeScreen() {
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === "web";

  const head = (
    <Head>
      <title>Moovo</title>
      <meta name="description" content="Moovo — send packages, food and moves." />
    </Head>
  );

  // WEB: the content flows in normal document flow (no vertical ScrollView) so the
  // BODY scrolls — scrolling works from anywhere, incl. over the sticky rail and
  // gutter (pure NativeWind classes, zero scroll JS).
  if (isWeb) {
    return (
      <>
        {head}
        {/* Decorative rounded-panel frame + bleed mask (desktop only, gated by
            CSS `max-md:hidden` — no JS width check). A STICKY overlay pinned to
            the viewport; the negative bottom margin gives it ~0 layout height so
            it doesn't push the content, while it frames the viewport and stays put
            as the body scrolls under it. The `boxShadow` paints a ring of the
            GUTTER color (Bloom `background` token — not hardcoded) around the
            rounded rect; `clip-path: inset(-12px)` keeps that ring from spilling
            onto the rail. `pointer-events-none` passes clicks. */}
        <View
          pointerEvents="none"
          className="max-md:hidden web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-3xl border border-border web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
          style={{
            boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${colors.background}`,
          }}
        />
        {/* The content panel flows in the document and scrolls with the body,
            passing under the sticky frame. Full-bleed below md, rounded card panel
            at md+. The content is centered (`mx-auto max-w-[2000px]`). */}
        <View className="relative w-full bg-card pb-24 web:min-h-screen web:overflow-x-clip md:rounded-3xl">
          <View className="web:mx-auto web:w-full web:max-w-[2000px]">
            <HomeBody />
          </View>
        </View>
      </>
    );
  }

  // NATIVE: a single full-height ScrollView (no document scroll on native).
  return (
    <View className="flex-1 bg-card">
      {head}
      <ScrollView
        className="flex-1 bg-card"
        contentContainerClassName="pb-24"
        keyboardShouldPersistTaps="handled"
      >
        <HomeBody />
      </ScrollView>
    </View>
  );
}
