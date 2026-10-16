/**
 * The media chokepoint resolves Oxy file ids and NOTHING else (oxy ADR 0043):
 * a URL used to be passed through, which made every `fileId` field a hotlink.
 */

import { describe, expect, it } from 'vitest';
import { isOxyFileId, resolveMedia } from '../media.service';

describe('resolveMedia', () => {
  it('resolves an Oxy file id to its public URL, with the variant', () => {
    const url = resolveMedia('019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', 'thumb');
    expect(url).toMatch(/\/019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b\?variant=thumb$/);
  });

  it('refuses a URL instead of passing it through', () => {
    expect(resolveMedia('https://cdn.example.com/a.png')).toBeUndefined();
    expect(resolveMedia('http://tracker.example/pixel.gif')).toBeUndefined();
    expect(resolveMedia('//cdn.example.com/a.png')).toBeUndefined();
  });

  it('refuses what cannot be a file id: empty, too long, with a path or spaces', () => {
    for (const value of ['', 'a'.repeat(65), 'a/b', 'a b', 'data:image/png;base64,AA']) {
      expect(isOxyFileId(value)).toBe(false);
      expect(resolveMedia(value)).toBeUndefined();
    }
  });
});
