import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(authorization.slice("Bearer ".length)), digest(token));
}
