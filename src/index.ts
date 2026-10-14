#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stripeBackend } from "./backend.js";
import { auditLogger, checkKey } from "./safety.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol, so anything human-readable goes to stderr.
try {
  const key = checkKey(process.env.STRIPE_API_KEY);
  const allowWrites = process.env.ALLOW_WRITES === "true";
  const auditPath =
    process.env.AUDIT_LOG === "off"
      ? null
      : (process.env.AUDIT_LOG ?? join(homedir(), ".stripe-collections-mcp", "audit.jsonl"));

  const server = createServer({
    backend: stripeBackend(key),
    allowWrites,
    audit: auditLogger(auditPath),
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `stripe-collections MCP running. Writes ${allowWrites ? "ON" : "off"}. Audit log: ${auditPath ?? "off"}`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
