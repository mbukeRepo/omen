/** Probability-forecast scoring shared by the backtests. */

export interface Scored {
  predictions: number;
  brier: number;
  brierClimatology: number;
  accuracy: number;
  baseRate: number;
  calibration: { bucket: string; n: number; meanProb: number; freq: number }[];
}

export function scoreProbabilities(rows: { prob: number; y: number }[]): Scored {
  const n = rows.length;
  const baseRate = rows.reduce((a, r) => a + r.y, 0) / n;
  const calibration: Scored["calibration"] = [];
  for (let lo = 0; lo < 1; lo += 0.2) {
    const hi = lo + 0.2;
    const inB = rows.filter((r) => r.prob >= lo && (hi >= 1 ? r.prob <= 1 : r.prob < hi));
    if (inB.length === 0) continue;
    calibration.push({
      bucket: `${lo.toFixed(1)}-${hi.toFixed(1)}`,
      n: inB.length,
      meanProb: inB.reduce((a, r) => a + r.prob, 0) / inB.length,
      freq: inB.reduce((a, r) => a + r.y, 0) / inB.length,
    });
  }
  return {
    predictions: n,
    brier: rows.reduce((a, r) => a + (r.prob - r.y) ** 2, 0) / n,
    brierClimatology: rows.reduce((a, r) => a + (baseRate - r.y) ** 2, 0) / n,
    accuracy: rows.filter((r) => r.prob > 0.5 === r.y > 0.5).length / n,
    baseRate,
    calibration,
  };
}

export function printScore(s: Scored, label: string): void {
  console.log(`\n${label}: ${s.predictions} predictions`);
  console.log(`Brier score:        ${s.brier.toFixed(4)}  (lower is better)`);
  console.log(`  always-50% ref:   0.2500`);
  console.log(`  climatology ref:  ${s.brierClimatology.toFixed(4)}  (base rate ${s.baseRate.toFixed(3)})`);
  console.log(`Accuracy @0.5:      ${(s.accuracy * 100).toFixed(1)}%`);
  console.log(`\nCalibration (model says → actually happens):`);
  console.table(
    s.calibration.map((b) => ({
      "model says": b.bucket,
      n: b.n,
      "mean prob": b.meanProb.toFixed(3),
      "actual freq": b.freq.toFixed(3),
    })),
  );
}
