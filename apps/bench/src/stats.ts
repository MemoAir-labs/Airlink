export type Percentiles = { p50: number; p95: number; p99: number; n: number };

// Type-7 quantile (R and NumPy default): rank = q·(n−1) into the sorted samples, then linear
// interpolation between the two neighbouring order statistics.
export function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => {
    if (sorted.length === 0) {
      return 0;
    }
    const rank = q * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.min(lower + 1, sorted.length - 1);
    return round(
      sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower])
    );
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), n: sorted.length };
}

const round = (value: number) => Math.round(value * 100) / 100;
