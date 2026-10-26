// PDF generation (pdfkit): contracts, investor statements, sample docs.
const PDFDocument = require("pdfkit");
const { fmtPKR } = require("../lib/money");
const G = "#0f5132", GOLD = "#c9a227";
function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Producer: "Shareek (demo)" } });
    const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    doc.rect(0, 0, doc.page.width, 60).fill(G); doc.fillColor("#fff").fontSize(22).text("Shar", 50, 20, { continued: true }).fillColor(GOLD).text("ik");
    doc.fillColor("#7a5c00").fontSize(8).text("DEMO — fictional data. Not a legal document. No real money.", 50, 70);
    doc.moveDown(1.5).fillColor("#1d2a24"); build(doc); doc.end();
  });
}
const kv = (doc, rows) => rows.forEach(([k, v]) => { doc.font("Helvetica-Bold").fontSize(10).text(k + ": ", { continued: true }).font("Helvetica").text(String(v ?? "—")); doc.moveDown(0.3); });
const contractPdf = (k) => render((doc) => {
  doc.fontSize(18).text(`${k.contract} Contract Summary`).fontSize(10).fillColor("#5f6f67").text(`Ref ${k.ref} · ${k.date}`).fillColor("#1d2a24").moveDown();
  kv(doc, [["Investor (rabb-ul-maal / partner)", k.parties.investor], ["Business", k.parties.business], ["Capital", fmtPKR(k.capitalPaisa)], ["Equity / capital share", k.equitySharePct.toFixed(4) + "% (post-money)"], ["Profit ratio", k.profitRatio], ["Profit", k.profitClause], ["Loss", k.lossClause], ["Guaranteed return", k.guaranteedReturn], ["Escrow", k.escrow], ["Shariah approval", k.shariahRef]]);
  doc.moveDown().fontSize(8).fillColor("#5f6f67").text(k.disclaimer);
});
const statementPdf = ({ user, portfolio, generatedAt }) => render((doc) => {
  const t = portfolio.totals;
  doc.fontSize(18).text("Investor Statement").fontSize(10).fillColor("#5f6f67").text(`${user.name} <${user.email}> · generated ${generatedAt}`).fillColor("#1d2a24").moveDown();
  kv(doc, [["Invested (active + escrow)", fmtPKR(t.investedPaisa)], ["In escrow", fmtPKR(t.escrowPaisa)], ["Refunded", fmtPKR(t.refundedPaisa)], ["Distributions (P/L)", fmtPKR(t.distributionsPaisa)], ["Purification outstanding", fmtPKR(t.purifyPaisa)], ["Wallet balance (ledger)", fmtPKR(t.walletPaisa)]]);
  doc.moveDown().font("Helvetica-Bold").fontSize(12).text("Holdings").font("Helvetica").fontSize(9).moveDown(0.3);
  portfolio.holdings.forEach((h) => doc.text(`${h.ref}  ${h.campaign.name}  ${h.campaign.structure}  ${fmtPKR(h.amountPaisa)}  ${h.status}  P/L ${fmtPKR(h.receivedPaisa)}`));
  doc.moveDown().font("Helvetica-Bold").fontSize(12).text("Distributions").font("Helvetica").fontSize(9).moveDown(0.3);
  portfolio.payouts.forEach((p) => doc.text(`${p.period}  ${p.campaign}  ${fmtPKR(p.amountPaisa)}  purification ${fmtPKR(p.purificationPaisa)}${p.donated ? " (donated)" : ""}`));
});
const samplePdf = (title, lines) => render((doc) => { doc.fontSize(18).text(title).moveDown(); doc.fontSize(11); lines.forEach((l) => doc.text(l).moveDown(0.5)); });
module.exports = { contractPdf, statementPdf, samplePdf };
