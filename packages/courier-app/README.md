# Moovo Go

Expo app for web, iOS, and Android — **Moovo Go**, the courier "on the road"
app. Couriers go online, accept jobs, and get paid. Mobile-first.

## What's here

- Provider tree: `OxyProvider` + `BloomThemeProvider` + `ImageResolverProvider` (`app/_layout.tsx`)
- Oxy SSO callback bootstrap (`app/+html.tsx`)
- API client with bearer-token injection (`lib/api/client.ts`)
- TanStack Query + Zustand stores
- NativeWind 5 (Tailwind v4 + postcss) theming via Bloom
- Sidebar shell, settings area, i18n (en/es)
- Push + web-push notification setup (`lib/hooks/use-notification-setup.ts`)

## Main routes

- `app/(app)/index.tsx` — home (online/offline toggle + courier job list)
- `app/(app)/notifications.tsx` — notification feed
- `app/(app)/settings/*` — settings area
- `app/(app)/forgot-password.tsx`, `reset-password.tsx` — auth helpers

## Development

```bash
# from repo root
bun run dev:app

# from packages/frontend
bun start
```

Platform targets:

```bash
bun run web
bun run ios
bun run android
```

## API config

Configured in `lib/config.ts` (respects `EXPO_PUBLIC_API_URL`). Production API:
`https://api.moovo.now`.

## Build

```bash
bun run build   # Expo web export -> dist/
```
