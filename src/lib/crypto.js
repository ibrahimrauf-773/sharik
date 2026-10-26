const crypto = require("crypto");
const env = require("../config");
const KEY = Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64");
// AES-256-GCM field encryption. Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}
function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("hex");
const randomToken = (n = 32) => crypto.randomBytes(n).toString("base64url");
const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
module.exports = { encrypt, decrypt, sha256, hmac, randomToken, safeEqual };
