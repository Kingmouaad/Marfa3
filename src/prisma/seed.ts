import { connectDatabase } from "./db.ts";

/** Kept for scaffold compatibility; auth data comes from Better Auth. */
export function seed(): Promise<void> {
  return connectDatabase().then(() => undefined);
}
