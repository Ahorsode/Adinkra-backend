/** Wraps a Hono handler as `(req, c) => Response`, with req.params filled in for this route. */
export const h = (fn) => (c) => {
  const req = c.get('req');
  req.params = c.req.param();
  return fn(req, c);
};

/** Parses an id from user input; anything outside the Postgres integer range becomes 0 (matches nothing). */
export function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : 0;
}
