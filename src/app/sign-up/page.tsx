"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth-client";
import { signUpSchema } from "@/lib/auth-schema";

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const parsed = signUpSchema.safeParse({
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      setPending(false);
      return;
    }

    const result = await signUp.email(parsed.data);
    setPending(false);

    if (result.error) {
      setError(result.error.message ?? "Sign up failed");
      return;
    }

    router.push("/dashboard");
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Create account</h1>
        <p className="muted">Sign up with email and password.</p>

        <label>
          Name
          <input name="name" type="text" autoComplete="name" required />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Sign up"}
        </button>

        <p className="muted">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
