// Route registry: one place declares method/path/auth/zod schemas; we register Express handlers AND build the OpenAPI spec.
const express = require("express");
const { z } = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema");
const { E } = require("../lib/errors");
const auth = require("../services/auth");
const router = express.Router();
const ops = [];
const toOpenApiPath = (p) => p.replace(/:([A-Za-z_]+)/g, "{$1}");
const js = (s) => { const o = zodToJsonSchema(s, { target: "openApi3", $refStrategy: "none" }); delete o.$schema; return o; };

async function loadUser(req, _res, next) { try { req.user = await auth.authenticate(req); next(); } catch (e) { next(e); } }
const guard = (mode) => async (req, res, next) => {
  try {
    if (mode === "public") return next();
    const user = await auth.authenticate(req).catch((e) => { if (mode === "optional") return null; throw e; });
    req.user = user;
    if (mode === "optional") return next();
    if (!user) throw E.unauth();
    if (Array.isArray(mode) && !mode.includes(user.role)) throw E.forbidden(`Requires role: ${mode.join(" or ")}`);
    next();
  } catch (e) { next(e); }
};
const validate = ({ body, query, params }) => (req, _res, next) => {
  try {
    if (params) req.params = params.parse(req.params);
    if (query) req.q = query.parse(req.query); else req.q = {};
    if (body) req.body = body.parse(req.body ?? {});
    next();
  } catch (e) { next(e); }
};
function def(method, path, o, handler) {
  const mw = [guard(o.auth || "public")];
  if (o.rateLimit) mw.unshift(o.rateLimit);
  if (o.pre) mw.push(...[].concat(o.pre));
  mw.push(validate(o));
  router[method](path, ...mw, async (req, res) => {
    const out = await handler(req, res);
    if (res.headersSent) return;
    if (out === undefined) return res.status(204).end();
    res.status(o.status || 200).json(out);
  });
  ops.push({ method, path, ...o });
}
function openapi(baseUrl) {
  const paths = {};
  for (const o of ops) {
    const p = toOpenApiPath(o.path); paths[p] ||= {};
    const parameters = [];
    if (o.params) for (const [k, v] of Object.entries(o.params.shape)) parameters.push({ name: k, in: "path", required: true, schema: js(v) });
    if (o.query) for (const [k, v] of Object.entries(o.query.shape)) parameters.push({ name: k, in: "query", required: !v.isOptional(), schema: js(v) });
    if (o.headers) for (const h of o.headers) parameters.push({ name: h, in: "header", required: false, schema: { type: "string" } });
    const roles = Array.isArray(o.auth) ? o.auth : null;
    paths[p][o.method] = {
      tags: [o.tag || "misc"], summary: o.summary, description: (o.description || "") + (roles ? `\n\nRoles: ${roles.join(", ")}` : o.auth === "user" ? "\n\nAny signed-in user." : ""),
      parameters,
      ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: js(o.body) } } } } : {}),
      ...(o.multipart ? { requestBody: { required: true, content: { "multipart/form-data": { schema: o.multipart } } } } : {}),
      ...(o.auth && o.auth !== "public" ? { security: [{ bearer: [] }] } : {}),
      responses: { [o.status || 200]: { description: "OK" }, 400: { $ref: "#/components/responses/Error" }, 401: { $ref: "#/components/responses/Error" }, 403: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" }, 409: { $ref: "#/components/responses/Error" }, 429: { $ref: "#/components/responses/Error" } },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "Sharik API", version: "1.0.0", description: "Shariah-compliant equity crowdfunding (demo). Money fields ending in `Paisa` are integers (1 PKR = 100 paisa). Errors: `{ error: { code, message, details? } }`. Auth: short-lived Bearer access token; refresh via httpOnly cookie + `X-CSRF-Token`." },
    servers: [{ url: baseUrl + "/api/v1" }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      responses: { Error: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } } } } } } },
    },
    paths,
  };
}
module.exports = { router, def, openapi, z, loadUser };
