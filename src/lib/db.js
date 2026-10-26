const { PrismaClient } = require("@prisma/client");
// BigInt (paisa) columns serialize as numbers in JSON (safe up to 9e15 paisa).
if (!BigInt.prototype.toJSON) BigInt.prototype.toJSON = function () { return Number(this); };
const db = global.__shareekDb || new PrismaClient();
if (process.env.NODE_ENV !== "production") global.__shareekDb = db;
module.exports = db;
