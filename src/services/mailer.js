// Pluggable mailer + SMS adapter. Resend when RESEND_API_KEY is set; otherwise log (dev outbox = Notification table).
const env = require("../config");
const log = require("../lib/logger");
let resend = null;
if (env.RESEND_API_KEY) { const { Resend } = require("resend"); resend = new Resend(env.RESEND_API_KEY); }
const mailer = {
  kind: resend ? "resend" : "console",
  async send({ to, subject, html, text }) {
    if (!resend) { log.info({ to, subject }, "[dev mailer] email logged (set RESEND_API_KEY to send)"); return { status: "logged" }; }
    const { error } = await resend.emails.send({ from: env.MAIL_FROM, to, subject, html, text });
    if (error) throw new Error("resend: " + (error.message || JSON.stringify(error)));
    return { status: "sent" };
  },
};
// SMS stub: plug Twilio / a local aggregator here when SMS_PROVIDER is configured.
const sms = {
  kind: env.SMS_PROVIDER || "console",
  async send({ to, text }) { log.info({ to, text }, "[sms stub] SMS logged (no provider configured)"); return { status: "logged" }; },
};
module.exports = { mailer, sms };
