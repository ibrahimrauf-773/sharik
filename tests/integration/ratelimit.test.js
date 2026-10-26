import { it, expect, afterAll } from "vitest";
const { app, request } = require("./helpers");
afterAll(() => { delete process.env.TEST_RATE_LIMIT; });
it("auth endpoints are rate limited", async () => {
  process.env.TEST_RATE_LIMIT = "1";
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await request(app).post("/api/v1/auth/login").send({ email: "x@example.com", password: "nope" })).status);
  expect(codes).toContain(401); expect(codes.at(-1)).toBe(429);
});
