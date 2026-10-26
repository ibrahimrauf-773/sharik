// Storage adapter: Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, else local disk.
// Both expose put / get / signedUrl. Local signed URLs are HMAC-signed and expire.
const fs = require("fs"), path = require("path");
const env = require("../config");
const { hmac, safeEqual } = require("../lib/crypto");
function local() {
  const root = path.resolve(env.UPLOAD_DIR);
  const p = (key) => { const f = path.resolve(root, key); if (!f.startsWith(root + path.sep)) throw new Error("bad key"); return f; };
  return {
    kind: "local",
    async put(key, buf) { const f = p(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); },
    async get(key) { return fs.readFileSync(p(key)); },
    async signedUrl(key, ttlSec = 300) {
      const exp = Math.floor(Date.now() / 1000) + ttlSec;
      return `${env.API_URL}/api/v1/files/${encodeURIComponent(key)}?exp=${exp}&sig=${hmac(env.FILE_URL_SECRET, key + ":" + exp)}`;
    },
    verify(key, exp, sig) { return +exp > Date.now() / 1000 && safeEqual(sig || "", hmac(env.FILE_URL_SECRET, key + ":" + exp)); },
  };
}
function supabase() {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const b = () => sb.storage.from(env.SUPABASE_BUCKET);
  return {
    kind: "supabase",
    async put(key, buf, mime) { const { error } = await b().upload(key, buf, { contentType: mime, upsert: false }); if (error) throw new Error("supabase upload: " + error.message); },
    async get(key) { const { data, error } = await b().download(key); if (error) throw new Error(error.message); return Buffer.from(await data.arrayBuffer()); },
    async signedUrl(key, ttlSec = 300) { const { data, error } = await b().createSignedUrl(key, ttlSec); if (error) throw new Error(error.message); return data.signedUrl; },
  };
}
module.exports = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? supabase() : local();
