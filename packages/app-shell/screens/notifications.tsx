import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ExpoNotifications from 'expo-notifications';
import { useAuth } from '@oxy.so/services/ui/client';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiChat1Line } from '@oxy.so/bloom/icons/RiChat1Line';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { formatRelativeTime } from '@oxy.so/bloom/locale';
import { NotificationsScreen as BloomNotificationsScreen } from '@oxy.so/bloom/notifications';
import { PageHeader } from '@oxy.so/bloom/page-header';

import { useTranslation } from '../hooks/useTranslation';
import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  type Notification,
} from '../lib/hooks/use-notifications';

const TYPE_ICONS: Record<string, BloomIconComponent> = {
  trigger_result: RiFlashlightLine,
  proactive_insight: RiEyeLine,
  daily_briefing: RiTimeLine,
  price_alert: RiAlertLine,
  chat_response_ready: RiChat1Line,
  agent_task_complete: RiFlashlightLine,
};

const PRIORITY_STATUS = {
  urgent: 'error',
  high: 'error',
  normal: 'information',
  low: 'neutral',
} as const;

/** The notification feed: Bloom's `NotificationsScreen` over Moovo's `/notifications` API and the device's push permission. */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBlocked, setPushBlocked] = useState(false);

  const { data, isLoading, isError, refetch } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/(app)');
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    ExpoNotifications.getPermissionsAsync()
      .then(({ status }) => {
        setPushEnabled(status === 'granted');
        setPushBlocked(status === 'denied');
      })
      .catch(() => setPushBlocked(true));
  }, []);

  const onPushChange = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setPushEnabled(false);
      return;
    }
    const { status } = await ExpoNotifications.requestPermissionsAsync();
    setPushEnabled(status === 'granted');
    setPushBlocked(status === 'denied');
  }, []);

  const notifications = data?.notifications ?? [];
  const byId = new Map<string, Notification>(notifications.map((n) => [n._id, n]));

  const onNotificationPress = useCallback(
    (id: string) => {
      const notification = byId.get(id);
      if (!notification) return;
      if (notification.status !== 'read') markAsRead.mutate(id);
      if (notification.route) {
        router.push(notification.route as Parameters<typeof router.push>[0]);
      }
    },
    [byId, markAsRead, router],
  );

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        presentation="bar"
        title={t('notifications.title')}
        onBack={() => router.back()}
      />
      <BloomNotificationsScreen
        notifications={
          data
            ? notifications.map((n) => ({
                id: n._id,
                title: n.title,
                description: n.body,
                timestamp: formatRelativeTime(new Date(n.createdAt)),
                unread: n.status !== 'read' && n.status !== 'dismissed',
                status: PRIORITY_STATUS[n.priority] ?? 'neutral',
                icon: TYPE_ICONS[n.type],
              }))
            : undefined
        }
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        onNotificationPress={onNotificationPress}
        onMarkAllRead={(data?.unreadCount ?? 0) > 0 ? () => markAllAsRead.mutate() : undefined}
        push={
          Platform.OS === 'web'
            ? undefined
            : { enabled: pushEnabled, onChange: onPushChange, blocked: pushBlocked }
        }
      />
    </View>
  );
}
