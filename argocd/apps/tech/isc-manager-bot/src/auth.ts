import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const key = randomBytes(32);

function digest(value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(authorization.slice("Bearer ".length)), digest(token));
}
