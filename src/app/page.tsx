import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return (
    <main className="shell">
      <div className="hero">
        <p className="eyebrow">mrfa3</p>
        <h1>Next.js + Prisma 8 + Better Auth</h1>
        <p className="lede">
          Custom Prisma 8 adapter persists users and sessions in Postgres.
        </p>
        <div className="actions">
          {session ? (
            <>
              <Link className="button" href="/dashboard">
                Dashboard
              </Link>
              <span className="muted">Signed in as {session.user.email}</span>
            </>
          ) : (
            <>
              <Link className="button" href="/sign-up">
                Sign up
              </Link>
              <Link className="button secondary" href="/sign-in">
                Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
