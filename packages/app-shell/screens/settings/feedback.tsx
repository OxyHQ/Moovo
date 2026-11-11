import { View, Platform } from 'react-native';
import { KeyboardAwareScrollView } from '../../lib/keyboard';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { RatingInput } from '@oxy.so/bloom/rating';
import { SelectionCard } from '@oxy.so/bloom/card';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useState } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import apiClient from '../../lib/api/client';
import { isAxiosError } from 'axios';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBugLine } from '@oxy.so/bloom/icons/RiBugLine';
import { RiChat1Line } from '@oxy.so/bloom/icons/RiChat1Line';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiSparkling2Line } from '@oxy.so/bloom/icons/RiSparkling2Line';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '../../hooks/useTranslation';

type FeedbackType = 'bug' | 'feature' | 'improvement' | 'other';

interface FeedbackTypeOption {
  type: FeedbackType;
  labelKey: string;
  descriptionKey: string;
  icon: BloomIconComponent;
}

const feedbackTypes: FeedbackTypeOption[] = [
  {
    type: 'bug',
    labelKey: 'feedback.bugReport',
    descriptionKey: 'feedback.bugDescription',
    icon: RiBugLine,
  },
  {
    type: 'feature',
    labelKey: 'feedback.featureRequest',
    descriptionKey: 'feedback.featureDescription',
    icon: RiLightbulbLine,
  },
  {
    type: 'improvement',
    labelKey: 'feedback.improvement',
    descriptionKey: 'feedback.improvementDescription',
    icon: RiSparkling2Line,
  },
  {
    type: 'other',
    labelKey: 'feedback.other',
    descriptionKey: 'feedback.otherDescription',
    icon: RiChat1Line,
  },
];

export default function FeedbackScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useOxy();
  const [selectedType, setSelectedType] = useState<FeedbackType | null>(null);
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selectedType) {
      toast.error(t('feedback.selectType'));
      return;
    }

    if (!message.trim()) {
      toast.error(t('feedback.enterMessage'));
      return;
    }

    if (message.trim().length < 10) {
      toast.error(t('feedback.moreDetails'));
      return;
    }

    const epoch = oxyServices.http.getSessionEpoch();
    try {
      setSubmitting(true);

      await apiClient.post('/feedback', {
        type: selectedType,
        message: message.trim(),
        rating,
        metadata: { platform: Platform.OS, appVersion: '1.0.0' },
      });
      if (oxyServices.http.getSessionEpoch() !== epoch) return;
      toast.success(t('feedback.thankYou'));
      setSelectedType(null);
      setMessage('');
      setRating(null);
      router.back();
    } catch (error) {
      if (oxyServices.http.getSessionEpoch() !== epoch) return;
      const message = isAxiosError<{ error?: string }>(error)
        ? error.response?.data.error
        : undefined;
      toast.error(message || t('feedback.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const ratingLabels: Record<number, string> = {
    1: t('feedback.veryPoor'),
    2: t('feedback.poor'),
    3: t('feedback.average'),
    4: t('feedback.good'),
    5: t('feedback.excellent'),
  };

  const placeholderMap: Record<FeedbackType, string> = {
    bug: t('feedback.bugPlaceholder'),
    feature: t('feedback.featurePlaceholder'),
    improvement: t('feedback.improvementPlaceholder'),
    other: t('feedback.otherPlaceholder'),
  };

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        presentation="bar"
        title={t('feedback.title')}
        subtitle={t('feedback.subtitle')}
        onBack={() => router.back()}
      />

      <KeyboardAwareScrollView bottomOffset={20} className="flex-1 p-5">
        <View className="mx-auto w-full max-w-2xl gap-6">
          <Field label={t('feedback.typeQuestion')} multiple>
            <View className="gap-2">
              {feedbackTypes.map((option) => (
                <SelectionCard
                  key={option.type}
                  selection="single"
                  icon={option.icon}
                  title={t(option.labelKey)}
                  description={t(option.descriptionKey)}
                  selected={selectedType === option.type}
                  onPress={() => setSelectedType(option.type)}
                />
              ))}
            </View>
          </Field>

          <Field
            label={t('feedback.rateExperience')}
            description={rating ? ratingLabels[rating] : undefined}
          >
            <RatingInput
              value={rating}
              onChange={setRating}
              accessibilityLabel={t('feedback.rateExperience')}
            />
          </Field>

          <Textarea
            label={t('feedback.yourFeedback')}
            placeholder={
              selectedType ? placeholderMap[selectedType] : t('feedback.otherPlaceholder')
            }
            value={message}
            onValueChange={setMessage}
            rows={6}
            showCount
          />

          <Button
            onPress={handleSubmit}
            loading={submitting}
            disabled={!selectedType || !message.trim()}
          >
            {t('feedback.submitButton')}
          </Button>
          <Text className="text-center text-muted-foreground">{t('feedback.footerText')}</Text>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
