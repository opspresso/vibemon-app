async function readPng(response, maximumBytes, imageSizes) {
  if (!response.ok || !response.body) throw new Error('Character image request failed');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) { await reader.cancel(); throw new Error('Character image exceeds the size limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const header = new DataView(bytes.buffer);
  if (length < 24 || signature.some((byte, index) => bytes[index] !== byte) ||
      header.getUint32(12) !== 0x49484452 || !imageSizes.includes(header.getUint32(16)) || header.getUint32(20) !== header.getUint32(16)) {
    throw new Error('Character image must be a PNG with the registry dimensions');
  }
  return new Blob([bytes], { type: 'image/png' });
}

export async function characterImages(registry, { fetchImage = fetch, urls = URL, warn = console.warn } = {}) {
  const bundled = new Set(registry.bundledImageFiles);
  const created = [];
  const entries = await Promise.all(Object.entries(registry.characters).map(async ([name, config]) => {
    const local = `assets/characters/${config.image}`;
    if (bundled.has(config.image)) return [name, [local]];
    try {
      const response = await fetchImage(`${registry.staticBaseUrl}/characters/${config.image}`, {
        signal: AbortSignal.timeout(registry.imageFetchTimeoutMs), redirect: 'error'
      });
      const blob = await readPng(response, registry.imageMaxBytes, registry.imageSizes);
      const url = urls.createObjectURL(blob);
      created.push(url);
      return [name, [url, local]];
    } catch (error) {
      warn(`Character ${name}: ${error.message}`);
      return [name, [local]];
    }
  }));
  return { sources: Object.fromEntries(entries), dispose: () => created.splice(0).forEach(url => urls.revokeObjectURL(url)) };
}
