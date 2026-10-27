import { getUser, type User } from "@netlify/identity";

/** Resolves to the signed-in Identity user if they hold the `admin` role, otherwise a 401/403 Response. */
export async function requireAdmin(): Promise<User | Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Inicia sesión para continuar." }, { status: 401 });
  if (!user.roles?.includes("admin")) {
    return Response.json({ error: "Tu cuenta no tiene el rol de administrador." }, { status: 403 });
  }
  return user;
}
