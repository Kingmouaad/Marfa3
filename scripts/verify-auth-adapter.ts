/**
 * End-to-end check of the Prisma 8 Better Auth adapter against a real database.
 *
 *   DATABASE_URL=postgresql://... npx prisma db init
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-auth-adapter.ts
 *
 * Exercises the adapter both through Better Auth's public API (sign-up,
 * sign-in, session lookup, sign-out) and directly through every adapter
 * method and where-operator Better Auth can emit. Leaves no rows behind.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { connectDatabase, db } from "../src/prisma/db.ts";
import { prisma8Adapter } from "../src/lib/auth/prisma8-adapter.ts";

const run = randomUUID().slice(0, 8);
const results: { name: string; ok: boolean; error?: unknown }[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await connectDatabase();

  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "verify-auth-adapter-secret-0123456789abcdef",
    database: prisma8Adapter(db),
    emailAndPassword: { enabled: true },
  });
  const ctx = await auth.$context;
  const adapter = ctx.adapter;

  const email = `verify-${run}@example.com`;
  const password = "correct horse battery staple";
  let token = "";
  let userId = "";

  await check("sign up creates user, account and session", async () => {
    const res = await auth.api.signUpEmail({
      body: { name: "Verify User", email, password },
    });
    assert.ok(res.token);
    assert.equal(res.user.email, email);
    assert.ok(res.user.createdAt instanceof Date);
    userId = res.user.id;
  });

  await check("duplicate sign up is rejected", async () => {
    await assert.rejects(
      auth.api.signUpEmail({ body: { name: "Dup", email, password } }),
    );
  });

  await check("sign in with correct password returns a session", async () => {
    const res = await auth.api.signInEmail({ body: { email, password } });
    assert.ok(res.token);
    token = res.token;
  });

  await check("sign in with wrong password is rejected", async () => {
    await assert.rejects(
      auth.api.signInEmail({ body: { email, password: "wrong-password-1" } }),
    );
  });

  await check("getSession resolves the session from a bearer cookie", async () => {
    const headers = new Headers({
      cookie: `better-auth.session_token=${await signedToken(token)}`,
    });
    const session = await auth.api.getSession({ headers });
    assert.ok(session, "session should be found");
    assert.equal(session.user.email, email);
    assert.ok(session.session.expiresAt instanceof Date);
    assert.ok(session.session.expiresAt.getTime() > Date.now());
  });

  await check("listSessions returns both sessions", async () => {
    const sessions = await ctx.internalAdapter.listSessions(userId);
    assert.equal(sessions.length, 2);
  });

  await check("sign out deletes the session", async () => {
    await ctx.internalAdapter.deleteSession(token);
    const found = await ctx.internalAdapter.findSession(token);
    assert.equal(found, null);
  });

  // ---- direct adapter coverage ------------------------------------------

  const ids = [0, 1, 2, 3].map((i) => `v-${run}-${i}`);
  const now = Date.now();

  await check("create returns Date objects for timestamp fields", async () => {
    for (const [i, id] of ids.entries()) {
      const row = await adapter.create<Record<string, unknown>>({
        model: "verification",
        forceAllowId: true,
        data: {
          id,
          identifier: `ident-${run}-${i % 2}`,
          value: i === 3 ? `2024-01-01T00:00:00 looks like a date` : `val_${i}%`,
          expiresAt: new Date(now + i * 60_000),
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
      });
      assert.equal(row.id, id);
      assert.ok(row.expiresAt instanceof Date);
    }
  });

  await check("non-timestamp strings are returned as strings", async () => {
    const row = await adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "id", value: ids[3]! }],
    });
    assert.equal(typeof row?.value, "string");
  });

  await check("findOne with select returns only selected fields", async () => {
    const row = await adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "id", value: ids[0]! }],
      select: ["id", "value"],
    });
    assert.deepEqual(Object.keys(row ?? {}).sort(), ["id", "value"]);
  });

  await check("findMany sorts, limits and offsets", async () => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "id", operator: "in", value: ids }],
      sortBy: { field: "expiresAt", direction: "desc" },
      limit: 2,
      offset: 1,
    });
    assert.deepEqual(
      rows.map((r) => r.id),
      [ids[2], ids[1]],
    );
  });

  await check("findMany without limit returns all rows", async () => {
    const rows = await adapter.findMany({
      model: "verification",
      where: [{ field: "identifier", operator: "starts_with", value: `ident-${run}` }],
    });
    assert.equal(rows.length, 4);
  });

  await check("date comparison operators (gt/lt)", async () => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [
        { field: "id", operator: "in", value: ids },
        { field: "expiresAt", operator: "gt", value: new Date(now + 30_000) },
      ],
    });
    assert.equal(rows.length, 3);
  });

  await check("contains escapes LIKE wildcards", async () => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [
        { field: "id", operator: "in", value: ids },
        { field: "value", operator: "contains", value: "_1%" },
      ],
    });
    assert.deepEqual(rows.map((r) => r.id), [ids[1]]);
  });

  await check("ends_with and not_in", async () => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [
        { field: "value", operator: "ends_with", value: "%" },
        { field: "id", operator: "not_in", value: [ids[0]!] },
        { field: "identifier", operator: "starts_with", value: `ident-${run}` },
      ],
    });
    assert.deepEqual(rows.map((r) => r.id).sort(), [ids[1], ids[2]]);
  });

  await check("OR connector", async () => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [
        { field: "id", value: ids[0]!, connector: "OR" },
        { field: "id", value: ids[3]!, connector: "OR" },
      ],
    });
    assert.deepEqual(rows.map((r) => r.id).sort(), [ids[0], ids[3]]);
  });

  await check("eq null matches IS NULL", async () => {
    const count = await adapter.count({
      model: "user",
      where: [
        { field: "id", value: userId },
        { field: "image", value: null },
      ],
    });
    assert.equal(count, 1);
  });

  await check("count", async () => {
    const count = await adapter.count({
      model: "verification",
      where: [{ field: "identifier", value: `ident-${run}-0` }],
    });
    assert.equal(count, 2);
  });

  await check("update returns the updated row with Date fields", async () => {
    const row = await adapter.update<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "id", value: ids[0]! }],
      update: { value: "updated", updatedAt: new Date() },
    });
    assert.equal(row?.value, "updated");
    assert.ok(row?.updatedAt instanceof Date);
  });

  await check("updateMany returns affected count", async () => {
    const n = await adapter.updateMany({
      model: "verification",
      where: [{ field: "identifier", value: `ident-${run}-1` }],
      update: { value: "bulk" },
    });
    assert.equal(n, 2);
  });

  await check("delete removes one row", async () => {
    await adapter.delete({
      model: "verification",
      where: [{ field: "id", value: ids[0]! }],
    });
    const row = await adapter.findOne({
      model: "verification",
      where: [{ field: "id", value: ids[0]! }],
    });
    assert.equal(row, null);
  });

  await check("deleteMany returns deleted count", async () => {
    const n = await adapter.deleteMany({
      model: "verification",
      where: [{ field: "identifier", operator: "starts_with", value: `ident-${run}` }],
    });
    assert.equal(n, 3);
  });

  await check("transaction commits and exposes the adapter", async () => {
    await adapter.transaction(async (trx) => {
      await trx.create({
        model: "verification",
        forceAllowId: true,
        data: {
          id: `tx-${run}`,
          identifier: `tx-${run}`,
          value: "tx",
          expiresAt: new Date(now),
        },
      });
    });
    const n = await adapter.deleteMany({
      model: "verification",
      where: [{ field: "id", value: `tx-${run}` }],
    });
    assert.equal(n, 1);
  });

  await check("transaction rolls back on error", async () => {
    await assert.rejects(
      adapter.transaction(async (trx) => {
        await trx.create({
          model: "verification",
          forceAllowId: true,
          data: {
            id: `rb-${run}`,
            identifier: `rb-${run}`,
            value: "rb",
            expiresAt: new Date(now),
          },
        });
        throw new Error("boom");
      }),
      /boom/,
    );
    const n = await adapter.count({
      model: "verification",
      where: [{ field: "id", value: `rb-${run}` }],
    });
    assert.equal(n, 0);
  });

  await check("expired session is rejected and removed", async () => {
    const { token: expired } = await auth.api.signInEmail({
      body: { email, password },
    });
    await adapter.update({
      model: "session",
      where: [{ field: "token", value: expired }],
      update: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const headers = new Headers({
      cookie: `better-auth.session_token=${await signedToken(expired)}`,
    });
    assert.equal(await auth.api.getSession({ headers }), null);
  });

  await check("deleting the user cascades to sessions and accounts", async () => {
    await ctx.internalAdapter.deleteUser(userId);
    const sessions = await adapter.count({
      model: "session",
      where: [{ field: "userId", value: userId }],
    });
    const accounts = await adapter.count({
      model: "account",
      where: [{ field: "userId", value: userId }],
    });
    assert.equal(sessions + accounts, 0);
  });

  async function signedToken(value: string) {
    const { makeSignature } = await import("better-auth/crypto");
    const sig = await makeSignature(value, ctx.secret);
    return encodeURIComponent(`${value}.${sig}`);
  }
}

main()
  .catch((error) => results.push({ name: "setup", ok: false, error }))
  .finally(async () => {
    for (const r of results) {
      console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
      if (!r.ok) console.log(`      ${String((r.error as Error)?.message ?? r.error).split("\n")[0]}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
