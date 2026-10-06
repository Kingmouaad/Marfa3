# Better Auth adapter review: changes

**Date:** 2026-10-06
**Branch:** `ccr-9f938f04-28dusd`
**Commit:** `6275c87` (Fix Prisma 8 Better Auth adapter dates, types and transactions)

## Summary

The custom Prisma 8 adapter for Better Auth (`src/lib/auth/prisma8-adapter.ts`) was not working correctly. It returned every date to Better Auth as text, which meant expired sessions were still accepted. It also had TypeScript errors that broke `next build`, and it did not use transactions. All of these are fixed. The adapter now passes a 26-check end-to-end test against a real Postgres database; the original version passed 8 of those 26 checks.

## How it was verified

| Check | Before | After |
|---|---|---|
| `npm ci` (clean install) | ❌ fails (peer dependency conflict) | ✅ passes |
| `tsc --noEmit` (type-check) | ❌ 3 errors in the adapter | ✅ clean |
| `next build` | ❌ fails at the TypeScript step (same errors) | ✅ builds |
| ESLint | ✅ | ✅ |
| End-to-end adapter checks (`npm run auth:verify`) | ❌ 8 / 26 | ✅ 26 / 26 |
| HTTP flows against the built app (`next start`) | n/a | ✅ all pass |

The HTTP flows tested against `next start` were: sign up, get session, open `/dashboard` while signed in (200), sign out, open `/dashboard` while signed out (307 redirect to `/sign-in`), sign in with a wrong password (rejected), sign in, and the signed-in state shown on the home page.

The database was a local PostgreSQL 16 with the schema applied by `npx prisma db init`.

## Bugs fixed in `src/lib/auth/prisma8-adapter.ts`

### 1. Dates were never converted, so expired sessions were accepted (security)

- **Cause:** The `TimestamptzString` codec returns Postgres text format, for example `2026-10-06 14:24:25.12+00` (with a space). The adapter's `fromDbValue` only recognised ISO strings that contain a `T`, so it never converted anything. Better Auth received `expiresAt`, `createdAt` and `updatedAt` as plain strings.
- **Effect:** Better Auth checks session expiry by comparing `expiresAt` with the current `Date`. Comparing a string with a Date always comes out false, so a session was never treated as expired.
- **Second problem:** The regex was applied to every column. Any text value that looked like a date, such as a user's name, would have been turned into a `Date`.
- **Fix:** The adapter now sets `supportsDates: false`. Better Auth then converts `Date` to an ISO string on the way in, including in `where` clauses, and converts strings back to `Date` on the way out, using its own schema to decide which fields are dates. The regex-based `fromDbValue` / `mapRow` code is removed. `toDbValue` is kept only for Dates inside `in` / `not_in` arrays, which Better Auth passes through unchanged.

### 2. TypeScript errors broke the production build

- The `and(...)` / `or(...)` arguments were typed `unknown`.
- The `update` return type didn't match Better Auth's generic `CustomAdapter` signature.
- **Fix:** I corrected the generics and casts. `tsc` and `next build` now pass.

### 3. No transactions, so multi-step writes weren't atomic

- **Before:** The adapter set `transaction: false`, so sign-up saved the user row and the account row separately. A failure between the two could leave a user with no account.
- **Fix:** The adapter now implements `transaction` with `db.transaction(tx => …)`, building a second adapter on `tx.orm`. This is the same pattern Better Auth's own Kysely adapter uses. It can be turned off with `prisma8Adapter(db, { transaction: false })`.
- **Verified:** A commit test and a rollback-on-error test.

### 4. Update and delete calls sometimes had no filter

- Prisma 8's `update`, `updateAndCount`, `delete` and `deleteAndCount` all require a prior `.where(...)`. The adapter skipped `.where()` when Better Auth passed an empty `where`.
- **Fix:** The adapter now always adds `.where()`. An empty filter becomes `and()`, which matches every row and is what Better Auth means by an empty `where`.

### 5. JSON and array support was misreported

- **Before:** The adapter claimed `supportsJSON: true` and `supportsArrays: true`, but the contract has no JSON or array columns.
- **Fix:** Both are now `false`, so Better Auth serialises those values itself if a plugin adds such fields.

## Other changes

| File | Change | Why |
|---|---|---|
| `.npmrc` (new) | `legacy-peer-deps=true` | `better-auth` declares an optional peer of `prisma@^5 \|\| ^6 \|\| ^7`; the project uses Prisma 8, so `npm ci` failed. The existing lockfile was clearly generated with this setting, so it stays unchanged. A scoped `overrides` alternative was tried, but it pulled about 60 unrelated packages (redis, vite, vitest) into the lockfile. |
| `scripts/verify-auth-adapter.ts` (new) | 26-check end-to-end test | Covers sign-up, duplicate sign-up, sign-in with right and wrong passwords, `getSession`, `listSessions`, sign-out, expired-session rejection, every adapter method (`create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `transaction`), every `where` operator (`eq`, `ne`, `in`, `not_in`, `gt`, `lt`, `contains`, `starts_with`, `ends_with`, `OR`, null checks), escaping of LIKE wildcards, `select`, sort/limit/offset, transaction commit and rollback, and cascade delete. It cleans up after itself. |
| `package.json` | Added the `auth:verify` script | Runs the check script. |
| `README.md` | Added an "Auth" section | Explains how to run the check script. |
| `.gitignore` | Added `*.tsbuildinfo` | TypeScript's incremental build file was showing as untracked. |

### Running the check script

```bash
DATABASE_URL=postgresql://... npx prisma db init   # once, on an empty database
DATABASE_URL=postgresql://... npm run auth:verify
```

## Recommended follow-ups (not changed)

1. **Upgrade Next.js.** `next@16.1.6` has a **critical** advisory (HTTP request smuggling in rewrites), plus high-severity advisories through `postcss` and `sharp`. All of them are fixed in `next@16.3.8`, which is not a major version change.
2. **`.env.example`** contains the real Neon database host name (no password). Consider replacing it with a placeholder.
3. **Unused template files:** nothing imports `src/prisma/users.ts` (`listUsers`) or `src/prisma/seed.ts`.
4. The audit also flags `@prisma/composer` / `alchemy` dependencies. npm's suggested fix is a downgrade to `0.6.0`, which isn't a real fix, so these are best left until upstream releases one.
