export function createLatestRequest(loader) {
  let version = 0;
  return {
    async run(key) {
      const requestVersion = ++version;
      try {
        const value = await loader(key);
        return requestVersion === version ? { current: true, key, value } : { current: false, key };
      } catch (error) {
        if (requestVersion !== version) return { current: false, key };
        throw error;
      }
    },
    invalidate() { version += 1; },
  };
}
