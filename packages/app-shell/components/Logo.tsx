import type { ReactElement } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@oxy.so/bloom/theme';

const LOGO_PATH =
  'M100.78-60.78v-673.35h170.74q0-86.39 60.76-147.44 60.76-61.04 147.72-61.04 86.96 0 147.72 61.04 60.76 61.05 60.76 147.44h170.74v673.35H100.78Zm526.94-379.63q60.76-60.76 60.76-147.72h-106q0 43.22-29.63 72.85-29.63 29.63-72.85 29.63t-72.85-29.63q-29.63-29.63-29.63-72.85h-106q0 86.96 60.76 147.72 60.76 60.76 147.72 60.76 86.96 0 147.72-60.76Zm-250.2-293.72h204.96q0-43.22-29.63-72.85-29.63-29.63-72.85-29.63t-72.85 29.63q-29.63 29.63-29.63 72.85Z';

export interface LogoProps {
  /** Override the mark colour. Defaults to the theme's text colour. */
  color?: string;
  /** Square size in px. */
  size?: number;
}

/** Moovo brand mark: the one thing in this package that is Moovo's own, not Bloom's. */
export function Logo({ color, size = 28 }: LogoProps): ReactElement {
  const { colors } = useTheme();
  return (
    <Svg viewBox="0 -960 960 960" width={size} height={size}>
      <Path d={LOGO_PATH} fill={color ?? colors.text} />
    </Svg>
  );
}
