import { createVectorAssetLoader } from '@oxy.so/bloom/agent-avatar/catalog';

/**
 * The agent-avatar assets the Moovo apps ship: none. Every avatar here is a person's image or
 * initials, so Bloom's 70-asset default catalog is resolved out of the bundle in each app's
 * `metro.config.js` (`@moovo/app-shell/metro/withoutAvatarCatalog`). To draw a character, list its
 * assets here (`@oxy.so/bloom/agent-avatar/catalog/<kind>-<id>`).
 */
export const avatarCatalog = createVectorAssetLoader({});
