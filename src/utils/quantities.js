// Converts Kubernetes quantities from metrics-server into numbers.

// "1" → 1000, "250m" → 250, "1500000n" → 1.5 (millicores).
export function cpuMillicores(quantity) {
  if (!quantity) return 0;
  const n = parseFloat(quantity);
  if (quantity.endsWith("n")) return n / 1e6;
  if (quantity.endsWith("m")) return n;
  return n * 1000;
}

const MEMORY_UNITS = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, k: 1e3, M: 1e6, G: 1e9 };

// "64Mi" → 67108864, "1G" → 1000000000 (bytes).
export function memoryBytes(quantity) {
  const match = /^([0-9.]+)([A-Za-z]*)$/.exec(quantity ?? "");
  if (!match) return 0;
  const [, number, unit] = match;
  return parseFloat(number) * (MEMORY_UNITS[unit] ?? 1);
}
