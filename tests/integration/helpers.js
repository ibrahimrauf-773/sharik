const request = require("supertest");
const { createApp } = require("../../src/app");
const app = createApp();
const agent = () => request.agent(app);
async function login(email, password, totp) {
  const a = agent();
  const r = await a.post("/api/v1/auth/login").send({ email, password, ...(totp ? { totp } : {}) });
  if (r.status !== 200) throw new Error("login failed " + r.status + JSON.stringify(r.body));
  a.token = r.body.accessToken; a.csrf = r.body.csrfToken; a.user = r.body.user;
  a.auth = (req) => req.set("Authorization", "Bearer " + a.token);
  return a;
}
module.exports = { app, request, agent, login };
