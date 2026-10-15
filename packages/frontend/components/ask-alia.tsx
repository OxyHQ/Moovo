import { useCallback, useMemo, useRef } from 'react';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';
import { VoiceSession } from '@alia.onl/sdk/voice';
import { Button } from '@oxy.so/bloom/button';
import { useAuth } from '@oxy.so/services';
import i18n from '@/lib/i18n';

/**
 * The "Ask Alia" button and the chat sheet it opens.
 *
 * Moovo's home is public, so the button is always there; pressing it signed out
 * opens the in-app Oxy sign-in dialog rather than a sheet that could not call
 * Alia. The sheet itself is mounted only once the session can use the private
 * API.
 */
export function AskAlia() {
  const { canUsePrivateApi, signIn } = useAuth();
  const chatRef = useRef<AliaChatSheetRef>(null);

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'send', text: i18n.t('alia.suggestion.send') },
      { id: 'track', text: i18n.t('alia.suggestion.track') },
      { id: 'price', text: i18n.t('alia.suggestion.price') },
    ],
    [],
  );

  const handleAskAlia = useCallback(() => {
    if (canUsePrivateApi) chatRef.current?.present();
    else void signIn();
  }, [canUsePrivateApi, signIn]);

  return (
    <>
      <Button size="sm" appearance="outline" leadingIcon={AliaAvatarIcon} onPress={handleAskAlia}>
        {i18n.t('alia.ask')}
      </Button>
      {canUsePrivateApi && (
        <AliaChatSheet
          ref={chatRef}
          voiceSession={VoiceSession}
          clientContext={i18n.t('alia.clientContext')}
          welcomeSuggestions={welcomeSuggestions}
        />
      )}
    </>
  );
}
