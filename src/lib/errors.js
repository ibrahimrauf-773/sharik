class AppError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const E = {
  bad: (m, d) => new AppError(400, "bad_request", m, d),
  unauth: (m = "Authentication required", code = "unauthorized") => new AppError(401, code, m),
  forbidden: (m = "Forbidden") => new AppError(403, "forbidden", m),
  notFound: (m = "Not found") => new AppError(404, "not_found", m),
  conflict: (m, code = "conflict") => new AppError(409, code, m),
};
module.exports = { AppError, E };
