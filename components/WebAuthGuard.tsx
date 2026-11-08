"use client";

import { useEffect } from "react";

/**
 * Sends the browser to /login when any API call reports an expired or
 * revoked web session (401 marked by X-OMP-Web-Auth). Other 401s, e.g. from
 * agent providers, are left to their callers.
 */
export function WebAuthGuard() {
  useEffect(() => {
    const original = window.fetch;
    let redirecting = false;
    const guarded: typeof window.fetch = async (...args) => {
      const response = await Reflect.apply(original, window, args) as Response;
      if (!redirecting && response.status === 401 && response.headers.get("x-omp-web-auth") === "required") {
        redirecting = true;
        window.location.replace("/login");
      }
      return response;
    };
    window.fetch = guarded;
    return () => { if (window.fetch === guarded) window.fetch = original; };
  }, []);
  return null;
}
