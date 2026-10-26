// Double-entry ledger. Lines: amount > 0 debit, < 0 credit; each entry sums to zero (also enforced by a DB trigger).
// Balances are always derived from lines; nothing stores a running balance.
const db = require("../lib/db");
const { N } = require("../lib/money");
const ACC = {
  clearing: () => ({ code: "asset:gateway_clearing", type: "asset", name: "Payment gateway clearing (mock)" }),
  wallet: (userId) => ({ code: `wallet:user:${userId}`, type: "liability", name: `Investor wallet #${userId}`, userId }),
  escrow: (campaignId) => ({ code: `escrow:campaign:${campaignId}`, type: "liability", name: `Escrow — campaign #${campaignId}`, campaignId }),
  founder: (campaignId) => ({ code: `payout:founder:campaign:${campaignId}`, type: "liability", name: `Founder payout — campaign #${campaignId}`, campaignId }),
  fee: () => ({ code: "revenue:platform_fee", type: "revenue", name: "Platform fee" }),
  purification: () => ({ code: "liability:purification_pool", type: "liability", name: "Purification (charity) pool" }),
};
async function account(tx, a) {
  return tx.ledgerAccount.upsert({ where: { code: a.code }, update: {}, create: { code: a.code, type: a.type, name: a.name, userId: a.userId ?? null, campaignId: a.campaignId ?? null } });
}
/** Post a balanced journal entry. Idempotent on `key`: re-posting returns the existing entry. */
async function post(tx, { key, kind, memo = "", lines }) {
  if (!key) throw new Error("idempotency key required");
  const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: key }, include: { lines: true } });
  if (existing) return { entry: existing, duplicate: true };
  const clean = lines.filter((l) => N(l.amount) !== 0);
  const sum = clean.reduce((a, l) => a + N(l.amount), 0);
  if (sum !== 0) throw new Error(`unbalanced journal entry ${key}: ${sum}`);
  if (clean.some((l) => !Number.isSafeInteger(N(l.amount)))) throw new Error("ledger amounts must be integer paisa");
  const accts = await Promise.all(clean.map((l) => account(tx, l.account)));
  const entry = await tx.journalEntry.create({ data: { idempotencyKey: key, kind, memo, lines: { create: clean.map((l, i) => ({ accountId: accts[i].id, amountPaisa: BigInt(N(l.amount)) })) } }, include: { lines: true } });
  return { entry, duplicate: false };
}
const dr = (account, amount) => ({ account, amount: N(amount) });
const cr = (account, amount) => ({ account, amount: -N(amount) });
/** Raw debit-positive balance of an account code. */
async function rawBalance(code, tx = db) {
  const r = await tx.ledgerLine.aggregate({ where: { account: { code } }, _sum: { amountPaisa: true } });
  return N(r._sum.amountPaisa || 0);
}
/** Natural balance: assets debit-positive; liabilities/revenue credit-positive. */
async function balance(code, tx = db) {
  const raw = await rawBalance(code, tx);
  return code.startsWith("asset:") ? raw : 0 - raw || 0;
}
async function trialBalance(tx = db) {
  const rows = await tx.$queryRaw`SELECT a.code, a.type, a.name, COALESCE(SUM(l."amountPaisa"),0)::bigint AS raw FROM "LedgerAccount" a LEFT JOIN "LedgerLine" l ON l."accountId"=a.id GROUP BY a.id ORDER BY a.code`;
  const accounts = rows.map((r) => ({ code: r.code, type: r.type, name: r.name, balancePaisa: r.type === "asset" ? N(r.raw) : -N(r.raw) }));
  const total = rows.reduce((a, r) => a + N(r.raw), 0);
  return { accounts, debitMinusCredit: total, balanced: total === 0 };
}
module.exports = { ACC, post, dr, cr, balance, rawBalance, trialBalance };
