// Maçon Archive — who may read the studio's private data.
//
// A request proves it comes from a keeper by carrying that keeper's signed-in
// session token. The publishable key the site ships with proves nothing: it is
// public, so Supabase's own gateway check, which accepts it, is not enough.

export const KEEPERS = ["alex@studiomacon.co", "hannah@studiomacon.co"];

/** The signed-in keeper's email, or null for anyone else. */
export async function keeperEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") || "", Authorization: auth },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return KEEPERS.includes(String(u.email || "").toLowerCase()) ? u.email : null;
  } catch { return null; }
}

/** Equal strings compared in constant time, for shared secrets. */
export function sameSecret(given: string | null, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return d === 0;
}
