/**
 * Metro `resolveRequest` wrapper that keeps Bloom's default agent-avatar catalog out of the bundle.
 *
 * Bloom links its 70 vector assets (~30 MB of JSON) through one lazy `import('./vector-assets')` in
 * `agent-avatar/default-catalog`. No Moovo app draws a bot character (see `lib/avatarCatalog.ts`),
 * and Metro inlines no env var inside node_modules, so that one import resolves to an empty module.
 */
function withoutAvatarCatalog(upstream) {
  return (context, moduleName, platform) =>
    moduleName === './vector-assets' &&
    /agent-avatar[\\/]default-catalog\.(ts|js)$/.test(context.originModulePath)
      ? { type: 'empty' }
      : upstream(context, moduleName, platform);
}

module.exports = { withoutAvatarCatalog };
