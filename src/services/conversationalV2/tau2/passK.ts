function combinations(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

/**
 * pass^k = C(c, k) / C(n, k). Não usar (pass^1)^k.
 */
export function passAtK(successes: number, trials: number, k: number): number {
  const c = Math.max(0, Math.floor(successes));
  const n = Math.max(0, Math.floor(trials));
  if (k <= 0 || n < k || c < k) return 0;
  if (c === n) return 1;
  return combinations(c, k) / combinations(n, k);
}

export function passAt1(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  return Math.max(0, Math.min(1, successes / trials));
}

export function passAt4(successes: number, trials: number): number {
  return passAtK(successes, trials, 4);
}

export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.96
): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}
