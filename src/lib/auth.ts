import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/prisma/db";
import { prisma8Adapter } from "@/lib/auth/prisma8-adapter";

export const auth = betterAuth({
  database: prisma8Adapter(db),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [nextCookies()],
});
