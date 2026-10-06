"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { signInSchema } from "@/lib/auth-schema";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const parsed = signInSchema.safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      setPending(false);
      return;
    }

    const result = await signIn.email(parsed.data);
    setPending(false);

    if (result.error) {
      setError(result.error.message ?? "Sign in failed");
      return;
    }

    router.push("/dashboard");
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Sign in</h1>
        <p className="muted">Welcome back.</p>

        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>

        <p className="muted">
          No account? <Link href="/sign-up">Sign up</Link>
        </p>
      </form>
    </main>
  );
}
