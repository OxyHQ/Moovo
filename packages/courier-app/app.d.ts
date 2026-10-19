declare module '*.svg' {
  import * as React from 'react';
  import { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}

// Side-effect stylesheet imports (global.css, maplibre-gl's CSS) are compiled by
// Metro, not TypeScript. TS 6 checks side-effect imports by default.
declare module '*.css';
