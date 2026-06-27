import { useSyncExternalStore } from "react";

/**
 * DEV-ONLY auth bypass. Lets the "Skip login (debug)" button drop you into the
 * app without a Supabase session, by making the route guards treat you as signed
 * in. In-memory only (resets on reload). Remove before shipping.
 */
let bypassed = false;
const listeners = new Set<() => void>();

export function setAuthBypass(value: boolean) {
  bypassed = value;
  listeners.forEach((l) => l());
}

export function getAuthBypass() {
  return bypassed;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reactive read for the route guards. */
export function useAuthBypass() {
  return useSyncExternalStore(subscribe, getAuthBypass, getAuthBypass);
}
