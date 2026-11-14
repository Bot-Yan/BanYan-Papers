/* Shared by the two browser upload pages. Loaded after the vendored hash-wasm bundle. */
window.tree2Upload = (() => {
  const partSize = 4 * 1024 * 1024;
  const maxSize = 256 * 1024 * 1024;

  function newId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function hashFile(file, onProgress) {
    if (file.size > maxSize) throw new Error('文件超过 256 MiB');
    const hasher = await window.hashwasm.createSHA256();
    hasher.init();
    for (let offset = 0; offset < file.size; offset += partSize) {
      const end = Math.min(file.size, offset + partSize);
      hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
      onProgress?.(end / file.size);
    }
    return hasher.digest('hex');
  }

  return { partSize, maxSize, newId, hashFile };
})();
