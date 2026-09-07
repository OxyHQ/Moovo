const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

// Monorepo roots: this package lives at packages/tracker-app, so the workspace
// root is two levels up. Metro must watch the root and resolve from the hoisted
// root node_modules so it can follow the @moovo/shared-types workspace symlink
// to its source.
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

module.exports = (() => {
  const config = getDefaultConfig(projectRoot);

  config.watchFolders = [monorepoRoot];

  config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(monorepoRoot, "node_modules"),
  ];

  // Resolve the workspace dependency to shared-types SOURCE so live edits are
  // picked up without a rebuild.
  config.resolver.extraNodeModules = {
    "@moovo/shared-types": path.resolve(monorepoRoot, "packages/shared-types/src"),
  };

  // Package exports, for zod v4 compatibility.
  config.resolver.unstable_enablePackageExports = true;
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];
  config.resolver.assetExts = [
    ...config.resolver.assetExts,
    "wasm",
    "woff2",
    "woff",
  ];

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16,
    inlineVariables: false
  });
})();
