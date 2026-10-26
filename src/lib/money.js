// Integer paisa money math. 1 PKR = 100 paisa. All functions take/return integer Numbers (or BigInt-safe Numbers).
const toPaisa = (pkr) => { const n = Math.round(Number(pkr) * 100); if (!Number.isSafeInteger(n)) throw new Error("amount out of range"); return n; };
const toPKR = (paisa) => Number(paisa) / 100;
const N = (x) => (typeof x === "bigint" ? Number(x) : Number(x));

/**
 * Largest-remainder (Hamilton) allocation: split integer `total` across `weights` so that
 * parts are proportional, integral, and sum EXACTLY to total. Works for negative totals (losses).
 * Ties broken by larger weight, then lower index (deterministic).
 */
function allocate(total, weights) {
  total = N(total); weights = weights.map(N);
  if (!Number.isSafeInteger(total)) throw new Error("total must be an integer");
  const W = weights.reduce((a, b) => a + b, 0);
  if (W <= 0 || !weights.length) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1, T = Math.abs(total);
  // use BigInt to avoid precision loss on T * w
  const Tb = BigInt(T), Wb = BigInt(W);
  const base = weights.map((w) => Number((Tb * BigInt(w)) / Wb));
  const rem = weights.map((w, i) => ({ i, r: Number((Tb * BigInt(w)) % Wb), w }));
  let left = T - base.reduce((a, b) => a + b, 0);
  rem.sort((a, b) => b.r - a.r || b.w - a.w || a.i - b.i);
  for (let k = 0; k < left; k++) base[rem[k % rem.length].i] += 1;
  return base.map((x) => x * sign);
}

/** Multiply integer paisa by a ratio a/b with half-up rounding (away from zero), BigInt-exact. */
function mulDiv(x, a, b) {
  const X = BigInt(N(x)), A = BigInt(a), B = BigInt(b);
  const neg = (X < 0n) !== (A < 0n);
  const p = (X < 0n ? -X : X) * (A < 0n ? -A : A);
  const q = (p * 2n + B) / (2n * B);
  return Number(neg ? -q : q);
}
/** percentage with up to 4 decimals, e.g. pct(10000, 1.1) => 110 */
const pct = (x, p) => mulDiv(x, Math.round(p * 10000), 1000000);
const bps = (x, b) => mulDiv(x, b, 10000);
const fmtPKR = (paisa) => "Rs " + toPKR(paisa).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Allocate a period's net result across investments (paisa).
 * Profit: investor pool = net x investorRatio%; split pro-rata by capital (largest remainder).
 * Loss:   Musharakah: investors bear loss x capital/(capital+valuation); Mudarabah: investors bear whole loss.
 *         Each investor's loss is capped at their capital.
 * Purification: payout x impermissiblePct% for positive payouts.
 */
function allocateDistribution({ structure, investorRatio, valuationPaisa }, investments, netPaisa, impermissiblePct = 0) {
  netPaisa = N(netPaisa);
  const caps = investments.map((i) => N(i.amountPaisa));
  const capital = caps.reduce((a, b) => a + b, 0);
  if (!capital) return { pool: 0, rows: [] };
  let pool;
  if (netPaisa >= 0) pool = mulDiv(netPaisa, investorRatio, 100);
  else pool = structure === "Musharakah" ? mulDiv(netPaisa, capital, capital + N(valuationPaisa)) : netPaisa;
  if (pool < -capital) pool = -capital;
  const parts = allocate(pool, caps).map((p, k) => Math.max(p, -caps[k]));
  const rows = investments.map((inv, k) => ({ investmentId: inv.id, userId: inv.userId, amountPaisa: parts[k], purificationPaisa: parts[k] > 0 ? pct(parts[k], impermissiblePct) : 0 }));
  return { pool: parts.reduce((a, b) => a + b, 0), rows };
}

module.exports = { toPaisa, toPKR, allocate, mulDiv, pct, bps, fmtPKR, allocateDistribution, N };
