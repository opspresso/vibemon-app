import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { characterImages } from '../src/shared/character-images.mjs';
const characters = { vibemon: { image: 'vibemon-v2.png' } };
const registry = { characters, bundledImageFiles: ['vibemon-v2.png'], imageFetchTimeoutMs: 100, imageMaxBytes: 65536, imageSize: 128, staticBaseUrl: 'https://example.invalid' };

test('bundled sprites render without consulting even an unavailable network', async () => {
  const result = await characterImages(registry, { fetchImage: () => assert.fail('Bundled art must not wait for the network') });
  assert.deepEqual(result.sources, { vibemon: ['assets/characters/vibemon-v2.png'] });
  result.dispose(); result.dispose();
});
test('new versioned sprites are validated and their blob URLs released once', async () => {
  const bytes = await readFile(new URL('../src/assets/characters/vibemon-v2.png', import.meta.url));
  const released = [];
  const result = await characterImages({ ...registry, bundledImageFiles: [] }, {
    fetchImage: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response(bytes); },
    urls: { createObjectURL(blob) { assert.equal(blob.type, 'image/png'); return 'blob:validated'; }, revokeObjectURL: url => released.push(url) }
  });
  assert.deepEqual(result.sources.vibemon, ['blob:validated', 'assets/characters/vibemon-v2.png']);
  result.dispose(); result.dispose(); assert.deepEqual(released, ['blob:validated']);
});
test('oversized streams and decoded-image dimensions are rejected before creating URLs', async () => {
  const original = await readFile(new URL('../src/assets/characters/vibemon-v2.png', import.meta.url));
  const oversizedDimensions = Buffer.from(original); oversizedDimensions.writeUInt32BE(100000, 16);
  for (const bytes of [Buffer.alloc(65537), oversizedDimensions, Buffer.from('invalid')]) {
    const warnings = [];
    const result = await characterImages({ ...registry, bundledImageFiles: [] }, {
      fetchImage: async () => new Response(bytes), warn: text => warnings.push(text),
      urls: { createObjectURL: () => assert.fail('Invalid art must not reach the decoder') }
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(result.sources.vibemon, ['assets/characters/vibemon-v2.png']);
  }
});
