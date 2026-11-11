import type { ReactNode } from 'react';
import { View, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { PageHeader } from '@oxy.so/bloom/page-header';

interface FormScreenProps {
  title: string;
  children: ReactNode;
}

/**
 * A form page shell: Bloom's page header with a back affordance, over a
 * centered, scrollable padded body. Used by the create-company and
 * company-settings forms. Web title is set for the document head.
 */
export function FormScreen({ title, children }: FormScreenProps) {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>{title} · Moovo Hub</title>
      </Head>
      <PageHeader presentation="bar" title={title} onBack={() => router.back()} />

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-5 pb-24 gap-5 w-full max-w-2xl mx-auto"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}
