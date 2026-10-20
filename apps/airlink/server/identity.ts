import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type Person = { id: string; name: string };

const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
});

export const personCookie = "airlink_person";

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

// AirLink runs on the person's machine with no accounts: a name is the identity, and the cookie
// is signed so one tab cannot claim to be another person by editing it.
export function newPerson(name: string): Person {
  return { id: randomUUID().slice(0, 12), name: name.trim() };
}

export function personCookieValue(person: Person, secret: string): string {
  const payload = Buffer.from(JSON.stringify(person)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function readPerson(
  cookieHeader: string | undefined,
  secret: string
): Person | null {
  const raw = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${personCookie}=`))
    ?.slice(personCookie.length + 1);
  const [payload, signature] = raw?.split(".") ?? [];
  if (!payload || !signature) {
    return null;
  }
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const parsed = personSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
