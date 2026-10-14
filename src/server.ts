import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CollectionsBackend, Invoice } from "./backend.js";
import type { Audit } from "./safety.js";

export interface ServerOptions {
  backend: CollectionsBackend;
  /** Off unless the operator starts the server with ALLOW_WRITES=true. */
  allowWrites: boolean;
  audit: Audit;
  /** Injected so tests can pin the clock. */
  now?: () => Date;
}

const DAY = 86_400;
const OPEN_INVOICE_SCAN = 500;

// Stripe amounts for these currencies are already in whole units.
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function formatMoney(minor: number, currency: string): string {
  const major = ZERO_DECIMAL.has(currency.toLowerCase()) ? minor : minor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(major);
}

const isoDate = (unix: number | null) =>
  unix === null ? null : new Date(unix * 1000).toISOString().slice(0, 10);

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const refuse = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export function createServer(opts: ServerOptions): McpServer {
  const { backend, allowWrites, audit } = opts;
  const nowUnix = () => Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);

  /** Whole days past the due date. 0 or less means not overdue yet. */
  const daysOverdue = (inv: Invoice) =>
    inv.dueDate === null ? 0 : Math.floor((nowUnix() - inv.dueDate) / DAY);

  const who = (inv: Invoice) => inv.customerName ?? inv.customerEmail ?? inv.customerId;

  /** Every call is audited, and a Stripe failure comes back as a tool error, not a crash. */
  const run = async (
    tool: string,
    args: Record<string, unknown>,
    body: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    try {
      const result = await body();
      audit({ tool, args, outcome: result.isError ? "refused" : "ok" });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({ tool, args, outcome: "error", detail: message });
      return refuse(`Stripe call failed: ${message}`);
    }
  };

  const server = new McpServer({ name: "stripe-collections", version: "0.1.0" });

  server.registerTool(
    "list_overdue_invoices",
    {
      title: "List overdue invoices",
      description:
        "Open Stripe invoices that are past their due date, oldest first, with who owes it, how much, how many days late, and the customer's payment link.",
      inputSchema: {
        min_days_overdue: z.number().int().min(1).max(3650).default(1)
          .describe("Only invoices at least this many days past due."),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run("list_overdue_invoices", args, async () => {
        const open = await backend.listOpenInvoices(OPEN_INVOICE_SCAN);
        const overdue = open
          .filter((inv) => inv.dueDate !== null && daysOverdue(inv) >= args.min_days_overdue)
          .sort((a, b) => daysOverdue(b) - daysOverdue(a))
          .slice(0, args.limit);
        return ok({
          count: overdue.length,
          invoices: overdue.map((inv) => ({
            invoice_id: inv.id,
            number: inv.number,
            customer: who(inv),
            customer_id: inv.customerId,
            amount_due: formatMoney(inv.amountDue, inv.currency),
            days_overdue: daysOverdue(inv),
            due_date: isoDate(inv.dueDate),
            pay_link: inv.hostedInvoiceUrl,
          })),
        });
      }),
  );

  server.registerTool(
    "receivables_summary",
    {
      title: "Receivables summary",
      description:
        "Everything still owed on open invoices, grouped by how late it is (not yet due, 1-30, 31-60, 61-90, over 90 days), totaled per currency.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("receivables_summary", {}, async () => {
        const open = await backend.listOpenInvoices(OPEN_INVOICE_SCAN);
        const bucketOf = (inv: Invoice) => {
          const d = daysOverdue(inv);
          if (inv.dueDate === null || d <= 0) return "not_yet_due";
          if (d <= 30) return "days_1_30";
          if (d <= 60) return "days_31_60";
          if (d <= 90) return "days_61_90";
          return "days_over_90";
        };
        const totals: Record<string, Record<string, { count: number; minor: number }>> = {};
        for (const inv of open) {
          const cur = (totals[inv.currency] ??= {});
          const b = (cur[bucketOf(inv)] ??= { count: 0, minor: 0 });
          b.count += 1;
          b.minor += inv.amountDue;
        }
        const currencies = Object.fromEntries(
          Object.entries(totals).map(([currency, buckets]) => [
            currency,
            Object.fromEntries(
              Object.entries(buckets).map(([name, b]) => [
                name,
                { count: b.count, total: formatMoney(b.minor, currency) },
              ]),
            ),
          ]),
        );
        return ok({ open_invoices: open.length, currencies });
      }),
  );

  server.registerTool(
    "customer_payment_history",
    {
      title: "Customer payment history",
      description:
        "A customer's recent invoices and how late they usually pay. Use it before deciding whether a reminder is worth sending.",
      inputSchema: {
        customer_id: z.string().regex(/^cus_[A-Za-z0-9]+$/, "Expected a Stripe customer id (cus_...)."),
        limit: z.number().int().min(1).max(100).default(12),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run("customer_payment_history", args, async () => {
        const invoices = await backend.listCustomerInvoices(args.customer_id, args.limit);
        const late = invoices
          .filter((inv) => inv.status === "paid" && inv.paidAt !== null && inv.dueDate !== null)
          .map((inv) => Math.round(((inv.paidAt as number) - (inv.dueDate as number)) / DAY));
        const average = late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null;
        return ok({
          customer_id: args.customer_id,
          paid: invoices.filter((inv) => inv.status === "paid").length,
          open: invoices.filter((inv) => inv.status === "open").length,
          average_days_paid_after_due: average,
          paid_on_time: late.filter((d) => d <= 0).length,
          invoices: invoices.map((inv) => ({
            invoice_id: inv.id,
            number: inv.number,
            status: inv.status,
            amount: formatMoney(inv.status === "paid" ? inv.amountPaid : inv.amountDue, inv.currency),
            due_date: isoDate(inv.dueDate),
            paid_date: isoDate(inv.paidAt),
          })),
        });
      }),
  );

  server.registerTool(
    "send_invoice_reminder",
    {
      title: "Send invoice reminder",
      description:
        "Re-sends an overdue invoice email to the customer through Stripe. Blocked unless the server was started with ALLOW_WRITES=true, and it checks the invoice is still open and overdue before sending.",
      inputSchema: {
        invoice_id: z.string().regex(/^in_[A-Za-z0-9]+$/, "Expected a Stripe invoice id (in_...)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run("send_invoice_reminder", args, async () => {
        if (!allowWrites) {
          return refuse(
            "Writes are off, so nothing was sent. This server started read-only. Restart it with ALLOW_WRITES=true to let it send reminders.",
          );
        }
        const inv = await backend.getInvoice(args.invoice_id);
        if (inv.status !== "open") {
          return refuse(`Invoice ${inv.number ?? inv.id} is ${inv.status}, not open. Nothing was sent.`);
        }
        if (daysOverdue(inv) < 1) {
          return refuse(`Invoice ${inv.number ?? inv.id} isn't overdue yet. Nothing was sent.`);
        }
        await backend.sendInvoice(inv.id);
        return ok({
          sent: true,
          invoice_id: inv.id,
          number: inv.number,
          customer: who(inv),
          amount_due: formatMoney(inv.amountDue, inv.currency),
          days_overdue: daysOverdue(inv),
        });
      }),
  );

  return server;
}
