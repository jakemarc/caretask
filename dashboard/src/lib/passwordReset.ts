import { sendPasswordResetEmail, type Auth } from "firebase/auth";

// Password set/reset from the sign-in screens, via Firebase's
// emailed link. This is also how a Google-only account gets a
// password: completing the emailed flow adds email/password to
// the SAME account (same user, same data), and Google sign-in
// keeps working alongside it. With Firebase's email enumeration
// protection on, the request "succeeds" even for unknown
// addresses, so the sent message never confirms whether an
// account exists.

export const PASSWORD_RESET_SENT_MESSAGE =
  "Check your email — Firebase sent a link to set your password. If you requested it more than once, use the newest email.";

export async function requestPasswordReset(
  auth: Auth,
  email: string,
): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export function passwordResetErrorMessage(err: unknown): string {
  const code =
    err instanceof Error ? ((err as { code?: string }).code ?? "") : "";
  switch (code) {
    case "auth/invalid-email":
    case "auth/missing-email":
      return "That email address doesn't look right.";
    case "auth/too-many-requests":
      return "Too many reset requests — wait a bit, then try again.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in isn't enabled yet, so a password can't be set.";
    default:
      return "";
  }
}
