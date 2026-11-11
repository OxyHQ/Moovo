import { View } from 'react-native';
import { cn } from '../../lib/utils';
import { MoovoWordmark } from '../ui/moovo-wordmark';

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn('items-center mb-6', className)}>
      <MoovoWordmark width={200} />
    </View>
  );
}
