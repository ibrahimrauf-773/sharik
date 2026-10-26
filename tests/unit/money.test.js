import { describe, it, expect } from "vitest";
const m = require("../../src/lib/money");
describe("money", () => {
  it("toPaisa/toPKR", () => { expect(m.toPaisa(5000)).toBe(500000); expect(m.toPaisa(0.1 + 0.2)).toBe(30); expect(m.toPKR(12345)).toBe(123.45); });
  it("allocate sums exactly and is proportional", () => {
    for (let t = 0; t < 200; t++) {
      const w = Array.from({ length: 1 + (t % 9) }, (_, i) => 1 + ((i * 7919 + t * 31) % 100000));
      const total = (t * 104729) % 10000019;
      const p = m.allocate(total, w);
      expect(p.reduce((a, b) => a + b, 0)).toBe(total);
      const W = w.reduce((a, b) => a + b, 0);
      p.forEach((x, i) => expect(Math.abs(x - (total * w[i]) / W)).toBeLessThan(1));
    }
  });
  it("allocate splits 100 among 3 equals as 34/33/33 deterministically", () => expect(m.allocate(100, [1, 1, 1])).toEqual([34, 33, 33]));
  it("allocate negative totals", () => expect(m.allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]));
  it("allocate zero weights", () => expect(m.allocate(100, [0, 0])).toEqual([0, 0]));
  it("mulDiv half-up, bps, pct", () => { expect(m.mulDiv(5, 1, 2)).toBe(3); expect(m.mulDiv(-5, 1, 2)).toBe(-3); expect(m.bps(6000000_00, 250)).toBe(15000000); expect(m.pct(10000, 1.1)).toBe(110); });
  it("huge values stay exact", () => { const p = m.allocate(9e15, [1, 2]); expect(p[0] + p[1]).toBe(9e15); });
  it("allocateDistribution profit with purification", () => {
    const r = m.allocateDistribution({ structure: "Musharakah", investorRatio: 60, valuationPaisa: 1e9 }, [{ id: 1, userId: 1, amountPaisa: 100 }, { id: 2, userId: 2, amountPaisa: 200 }], 1001, 1.1);
    expect(r.pool).toBe(601); expect(r.rows.map((x) => x.amountPaisa)).toEqual([200, 401]); expect(r.rows[1].purificationPaisa).toBe(4);
  });
  it("Musharakah loss shared by capital share and capped", () => {
    const r = m.allocateDistribution({ structure: "Musharakah", investorRatio: 60, valuationPaisa: 700 }, [{ id: 1, amountPaisa: 100 }, { id: 2, amountPaisa: 200 }], -1000);
    expect(r.pool).toBe(-300); expect(r.rows.every((x) => x.purificationPaisa === 0)).toBe(true);
  });
  it("Mudarabah loss borne by capital, capped at capital", () => {
    const r = m.allocateDistribution({ structure: "Mudarabah", investorRatio: 50, valuationPaisa: 0 }, [{ id: 1, amountPaisa: 100 }], -5000);
    expect(r.pool).toBe(-100);
  });
});
