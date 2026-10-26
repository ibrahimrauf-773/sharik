// Append-only audit log (UPDATE/DELETE blocked by DB trigger).
const db = require("./db");
async function audit(action, { actorId = null, entity = null, entityId = null, data = null, ip = null } = {}, tx = db) {
  return tx.auditLog.create({ data: { action, actorId, entity, entityId: entityId == null ? null : String(entityId), data: data ?? undefined, ip } });
}
module.exports = { audit };
