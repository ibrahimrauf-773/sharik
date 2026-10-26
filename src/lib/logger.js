const pino = require("pino");
const env = require("../config");
module.exports = pino({ level: env.isTest ? "silent" : env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash", "*.token", "*.cnic"] });
