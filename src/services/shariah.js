// AAOIFI-style screening + contract summary builder.
const { fmtPKR, N } = require("../lib/money");
const HARAM = ["alcohol", "gambling", "conventional finance", "pork", "adult entertainment", "tobacco", "interest-based lending"];
function screen(c) {
  const checks = [
    { key: "sector", label: "Business activity is halal", pass: !c.haramSector, detail: c.haramSector ? "Core activity falls in a prohibited sector" : `${c.sector} — permissible` },
    { key: "debt", label: "Interest-bearing debt < 33% of market cap", pass: c.interestDebtRatio < 33, detail: `${c.interestDebtRatio}%` },
    { key: "income", label: "Impermissible income < 5% of revenue", pass: c.interestIncomePct < 5, detail: `${c.interestIncomePct}%` },
    { key: "structure", label: "Approved structure (Musharakah / Mudarabah)", pass: ["Musharakah", "Mudarabah"].includes(c.structure), detail: c.structure },
    { key: "ratio", label: "Profit ratio pre-agreed, no guaranteed return", pass: c.investorRatio > 0 && c.investorRatio < 100, detail: `${c.investorRatio}% to investors` },
  ];
  return { pass: checks.every((x) => x.pass), checks, standard: "AAOIFI Shariah Standard 21 (screening thresholds)" };
}
function contractSummary({ investment, campaign, user }) {
  const amt = N(investment.amountPaisa), post = N(campaign.valuationPaisa) + N(campaign.targetPaisa);
  const isM = campaign.structure === "Musharakah";
  return {
    ref: investment.ref, contract: campaign.structure, date: new Date().toISOString().slice(0, 10),
    parties: { investor: user.name, business: campaign.name },
    capitalPaisa: amt, capital: fmtPKR(amt),
    equitySharePct: (amt / post) * 100,
    profitRatio: `${campaign.investorRatio}:${100 - campaign.investorRatio} (investors : ${isM ? "founders" : "mudarib"})`,
    profitClause: `Actual profits are shared ${campaign.investorRatio}% to investors pro-rata to capital; no fixed or guaranteed amount.`,
    lossClause: isM ? "Losses are borne in proportion to capital contributed (Musharakah), capped at your capital." : "Financial losses are borne by the capital provider (rabb-ul-maal); the mudarib loses effort, unless negligence is proven.",
    guaranteedReturn: "None — guaranteed returns would constitute riba.",
    escrow: "Funds held in a segregated escrow account until the campaign closes; refunded in full if the target is not met.",
    shariahRef: campaign.shariahRef,
    disclaimer: "Demo summary of key terms. Fictional data; not a legal agreement.",
  };
}
module.exports = { screen, contractSummary, HARAM };
