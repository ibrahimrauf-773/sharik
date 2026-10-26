// Notifications: persisted in Notification table (= dev outbox), delivered by a background job.
const db = require("../lib/db");
const jobs = require("./jobs");
const render = require("./templates");
const { mailer, sms } = require("./mailer");
async function notify({ user, to, template, data, channel = "email" }) {
  const msg = render(template, { name: user?.name || "", ...data });
  const n = await db.notification.create({ data: { channel, to: to || (channel === "sms" ? user?.phone : user?.email) || "", template, subject: msg.subject, body: channel === "sms" ? msg.text : msg.html, userId: user?.id ?? null } });
  await jobs.enqueue("deliverNotification", { id: n.id });
  return n;
}
jobs.register("deliverNotification", async ({ id }) => {
  const n = await db.notification.findUnique({ where: { id } });
  if (!n || n.status === "sent" || n.status === "logged" || !n.to) return;
  try {
    const r = n.channel === "sms" ? await sms.send({ to: n.to, text: n.body }) : await mailer.send({ to: n.to, subject: n.subject, html: n.body });
    await db.notification.update({ where: { id }, data: { status: r.status, sentAt: new Date(), error: null } });
  } catch (e) { await db.notification.update({ where: { id }, data: { status: "failed", error: e.message } }); throw e; }
});
module.exports = { notify };
