import { connectDatabase, db } from "./db.ts";

export { db };

/** No demo seed — auth users are created via Better Auth signup. */
export async function listUsers(limit = 10) {
  await connectDatabase();
  const users = await db.orm.public.User.select("id", "email", "name", "createdAt")
    .limit(limit)
    .all();

  return users.map((user) => ({
    id: String(user.id),
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  }));
}

export type StarterUser = Awaited<ReturnType<typeof listUsers>>[number];
