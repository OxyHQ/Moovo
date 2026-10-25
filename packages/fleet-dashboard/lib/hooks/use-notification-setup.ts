/**
 * useNotificationSetup — Push notification registration, foreground handling,
 * tap deep-linking, and real-time Socket.IO notification subscription.
 *
 * Call once in the authenticated app layout.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { openMoovoSocket } from '@/lib/socket';
import apiClient from '@/lib/api/client';

// ── Constants ──────────────────────────────────────────────────────
const PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId;

export function useNotificationSetup() {
  const { user, oxyServices, isAuthenticated } = useOxy();
  const sessionEpoch = oxyServices.http.getSessionEpoch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokenRef = useRef<{ accountId: string; token: string } | null>(null);
  const webPushRegisteredRef = useRef<string | null>(null);

  // ── Foreground notification display (once, native only) ────────
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // ── Push token registration ────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id || Platform.OS === 'web') return;

    let cancelled = false;
    const epoch = sessionEpoch;
    const current = () => !cancelled && oxyServices.http.getSessionEpoch() === epoch;

    (async () => {
      try {
        // Android: create notification channel
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }

        // Check / request permission
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || !current()) return;

        // A configured EAS projectId is required to mint an Expo push token.
        // Until the app is registered with EAS, skip native push registration.
        if (!PROJECT_ID) return;

        // Get Expo push token
        const { data: token } = await Notifications.getExpoPushTokenAsync({
          projectId: PROJECT_ID,
        });
        if (
          !current() ||
          !token ||
          (tokenRef.current?.accountId === user.id && tokenRef.current.token === token)
        )
          return;

        // Register with backend
        await apiClient.post('/notifications/push-token', {
          token,
          platform: Platform.OS,
        });
        if (current()) tokenRef.current = { accountId: user.id, token };
      } catch {
        // Non-critical — expected to fail in dev without FCM credentials
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id, sessionEpoch, oxyServices]);

  // ── Notification tap handler (deep-link) ───────────────────────
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (!isAuthenticated) return;
      const data = response.notification.request.content.data;
      // Notifications may carry an in-app `route` to deep-link to.
      if (typeof data?.route === 'string') {
        router.push(data.route as Parameters<typeof router.push>[0]);
      }
    });

    return () => subscription.remove();
  }, [router, isAuthenticated]);

  // ── Web push registration (browser only) ──────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web' || !isAuthenticated || !user?.id) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (webPushRegisteredRef.current === user.id) return;

    let cancelled = false;
    const epoch = sessionEpoch;
    const current = () => !cancelled && oxyServices.http.getSessionEpoch() === epoch;

    (async () => {
      try {
        // Fetch VAPID public key from backend
        const { data: vapidData } = await apiClient.get('/notifications/vapid-public-key');
        if (!current() || !vapidData?.publicKey) return;

        // Register service worker
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Check for existing subscription
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
          // Request permission
          const permission = await Notification.requestPermission();
          if (!current() || permission !== 'granted') return;

          // Convert VAPID key from base64url to Uint8Array
          const vapidKey = urlBase64ToUint8Array(vapidData.publicKey);

          // Subscribe
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: vapidKey,
          });
        }

        if (!current() || !subscription) return;

        // Send subscription to backend
        const subJson = subscription.toJSON();
        await apiClient.post('/notifications/web-push-subscription', {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        });

        if (current()) webPushRegisteredRef.current = user.id;
      } catch {
        // Non-critical — web push not available in all browsers/contexts
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id, sessionEpoch, oxyServices]);

  // ── Socket.IO real-time notification subscription ──────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id || oxyServices.http.getSessionEpoch() !== sessionEpoch)
      return;
    const connection = openMoovoSocket(oxyServices);
    const { socket } = connection;

    socket.on('notification', () => {
      if (!connection.isCurrent()) return;
      // Invalidate React Query caches so notification list + unread count refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    connection.connect();
    return () => connection.dispose();
  }, [isAuthenticated, sessionEpoch, user?.id, oxyServices, queryClient]);
}

// ── Helpers ──────────────────────────────────────────────────────

/** Convert a base64url-encoded VAPID key to a Uint8Array for PushManager.subscribe */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
