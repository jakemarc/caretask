import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { fetchMyStaffRecord, type ApiUser } from "./patientApi";

// The signed-in user's own staff record, shared across views.
// The manager PIN was retired on 2026-11-02: gated actions now
// depend on the caller's ROLE, so views need to know it — to show
// manager-only actions only to managers/admins (the API remains
// the enforcement; this is presentation). One /users/me call per
// sign-in, cached at module level and shared by every mounted
// view. Returns undefined while loading, null when the user has
// no staff record or the API is unreachable.
const cache = new Map<string, Promise<ApiUser | null>>();

export function useMyStaff(user: User | null): ApiUser | null | undefined {
  const [me, setMe] = useState<ApiUser | null | undefined>(undefined);
  useEffect(() => {
    if (!user) {
      setMe(null);
      return;
    }
    let p = cache.get(user.uid);
    if (!p) {
      p = fetchMyStaffRecord(user).catch(() => null);
      cache.set(user.uid, p);
    }
    let live = true;
    p.then((rec) => {
      if (live) setMe(rec);
    });
    return () => {
      live = false;
    };
  }, [user]);
  return me;
}

// True when the staff record is an active manager or admin —
// the two roles the API's role gates accept.
export function isManagerRole(
  me: ApiUser | null | undefined,
): boolean {
  return !!me && me.active && (me.role === "manager" || me.role === "admin");
}
