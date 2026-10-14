import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * This server only talks to Stripe test mode. A live key stops it before it
 * connects to anything. For a real client this becomes a deliberate config
 * switch, never a default.
 */
export function checkKey(key: string | undefined): string {
  if (!key) {
    throw new Error("STRIPE_API_KEY is not set. Use a test-mode key (sk_test_ or rk_test_).");
  }
  if (/^(sk|rk)_live_/.test(key)) {
    throw new Error("Refusing a live Stripe key. This server only runs against test mode.");
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("STRIPE_API_KEY doesn't look like a Stripe test key (sk_test_ or rk_test_).");
  }
  return key;
}

export type AuditEntry = Record<string, unknown>;
export type Audit = (entry: AuditEntry) => void;

/** One JSON line per tool call, reads and writes both. Null path turns it off. */
export function auditLogger(path: string | null): Audit {
  if (!path) return () => {};
  mkdirSync(dirname(path), { recursive: true });
  return (entry) => {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  };
}
