// Side-effect stylesheet imports (global.css, maplibre-gl's CSS) are compiled by
// Metro, not TypeScript. TS 6 checks side-effect imports by default.
declare module '*.css';
