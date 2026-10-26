const crypto = require("crypto");
const path = require("path");
const db = require("../lib/db");
const { E } = require("../lib/errors");
const storage = require("./storage");
const { audit } = require("../lib/audit");
const ALLOWED = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx" };
const MAX = 10 * 1024 * 1024;
function sniff(buf, mime) {
  // basic magic-byte checks (don't trust client mime)
  if (mime === "application/pdf") return buf.slice(0, 5).toString() === "%PDF-";
  if (mime === "image/png") return buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (mime.includes("presentationml")) return buf.slice(0, 2).toString() === "PK";
  return false;
}
async function save({ buf, mime, filename, kind, title, campaignId = null, ownerId = null, visibility = "public", actorId, ip }) {
  if (!ALLOWED[mime]) throw E.bad("Unsupported file type (PDF, PNG, JPG, PPTX only)");
  if (buf.length > MAX) throw E.bad("File too large (max 10 MB)");
  if (!sniff(buf, mime)) throw E.bad("File content does not match its type");
  const key = `${visibility}/${campaignId ? "campaign-" + campaignId : "user-" + ownerId}/${kind}/${crypto.randomBytes(8).toString("hex")}${ALLOWED[mime]}`;
  await storage.put(key, buf, mime);
  const d = await db.document.create({ data: { kind, title: title || filename, filename: path.basename(filename).slice(0, 120), mime, size: buf.length, storageKey: key, visibility, campaignId, ownerId } });
  await audit("document.uploaded", { actorId, entity: "Document", entityId: d.id, data: { kind, campaignId, visibility }, ip });
  return d;
}
async function canRead(user, d) {
  if (d.deletedAt) return false;
  if (d.visibility === "public") return true;
  if (!user) return false;
  if (user.role === "admin" || d.ownerId === user.id) return true;
  if (d.campaignId) { const c = await db.campaign.findUnique({ where: { id: d.campaignId } }); return c?.founderId === user.id; }
  return false;
}
async function signedUrl(user, id) {
  const d = await db.document.findUnique({ where: { id } });
  if (!d || !(await canRead(user, d))) throw E.notFound("Document not found");
  return { url: await storage.signedUrl(d.storageKey, d.visibility === "public" ? 3600 : 300), expiresIn: d.visibility === "public" ? 3600 : 300, filename: d.filename, mime: d.mime };
}
async function remove(user, id, ip) {
  const d = await db.document.findUnique({ where: { id } });
  if (!d || d.deletedAt) throw E.notFound();
  const c = d.campaignId ? await db.campaign.findUnique({ where: { id: d.campaignId } }) : null;
  if (!(user.role === "admin" || d.ownerId === user.id || c?.founderId === user.id)) throw E.forbidden();
  await db.document.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit("document.deleted", { actorId: user.id, entity: "Document", entityId: id, ip });
}
module.exports = { save, signedUrl, remove, ALLOWED, MAX };
