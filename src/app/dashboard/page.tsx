import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Dashboard</h1>
        <p className="muted">You are signed in.</p>
        <dl className="session">
          <dt>Name</dt>
          <dd>{session.user.name}</dd>
          <dt>Email</dt>
          <dd>{session.user.email}</dd>
          <dt>User id</dt>
          <dd>
            <code>{session.user.id}</code>
          </dd>
        </dl>
        <div className="actions">
          <SignOutButton />
          <Link href="/">Home</Link>
        </div>
      </div>
    </main>
  );
}
