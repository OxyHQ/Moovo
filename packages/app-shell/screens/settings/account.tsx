import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from '../../hooks/useTranslation';

export function SettingsAccountScreen({ showBack = false }: { showBack?: boolean }) {
  const router = useRouter();
  const { isAuthenticated, user, showBottomSheet } = useOxy();
  const { t } = useTranslation();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/(app)');
    }
  }, [isAuthenticated, router]);

  const displayName = user?.name?.first
    ? [user.name.first, user.name.last].filter(Boolean).join(' ')
    : user?.username || t('common.user');

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        presentation="bar"
        title={t('settings.sections.account')}
        onBack={showBack ? () => router.back() : null}
      />
      <ScrollView className="flex-1" contentContainerClassName="max-w-2xl gap-6 p-5">
        <View className="flex-row items-center gap-4">
          <Avatar source={user?.avatar} name={displayName} size={56} />
          <View className="flex-1">
            <Text variant="title-3-semibold">{displayName}</Text>
            {user?.email ? <Text className="text-muted-foreground">{user.email}</Text> : null}
          </View>
        </View>
        <GroupedSection>
          <GroupedSectionItem
            title={t('settings.account.title')}
            onPress={() => showBottomSheet?.('ManageAccount')}
          />
        </GroupedSection>
        <GroupedSection>
          <GroupedSectionItem
            title={t('settings.sections.general')}
            onPress={() => router.push('/settings/general')}
          />
          <GroupedSectionItem
            title={t('account.notifications')}
            onPress={() => router.push('/notifications')}
          />
          <GroupedSectionItem
            title={t('feedback.title')}
            onPress={() => router.push('/settings/feedback')}
          />
        </GroupedSection>
      </ScrollView>
    </View>
  );
}
