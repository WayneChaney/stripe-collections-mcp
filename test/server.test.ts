import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CollectionsBackend, Invoice } from "../src/backend.js";
import { checkKey, type AuditEntry } from "../src/safety.js";
import { createServer } from "../src/server.js";

const DAY = 86_400;
const NOW = new Date("2026-09-26T12:00:00Z");
const nowUnix = Math.floor(NOW.getTime() / 1000);
const daysAgo = (n: number) => nowUnix - n * DAY;

function invoice(over: Partial<Invoice> & { id: string }): Invoice {
  return {
    number: over.id.toUpperCase(),
    customerId: "cus_X",
    customerName: null,
    customerEmail: null,
    amountDue: 0,
    amountPaid: 0,
    currency: "usd",
    status: "open",
    dueDate: null,
    paidAt: null,
    created: daysAgo(200),
    hostedInvoiceUrl: `https://invoice.stripe.com/i/${over.id}`,
    ...over,
  };
}

const OPEN: Invoice[] = [
  invoice({ id: "in_A", customerId: "cus_A", customerName: "Acme Roofing", amountDue: 120_000, dueDate: daysAgo(45) }),
  invoice({ id: "in_B", customerId: "cus_B", customerName: "Blue Door Bakery", amountDue: 35_000, dueDate: daysAgo(5) }),
  invoice({ id: "in_C", customerId: "cus_C", amountDue: 50_000, dueDate: daysAgo(-10) }),
  invoice({ id: "in_D", customerId: "cus_D", amountDue: 8_000, dueDate: null }),
  invoice({ id: "in_E", customerId: "cus_E", customerEmail: "customer@example.test", amountDue: 90_000, currency: "eur", dueDate: daysAgo(120) }),
];

const PAID: Invoice[] = [
  invoice({ id: "in_F", customerId: "cus_B", status: "paid", amountPaid: 35_000, dueDate: daysAgo(40), paidAt: daysAgo(30) }),
  invoice({ id: "in_G", customerId: "cus_B", status: "paid", amountPaid: 35_000, dueDate: daysAgo(70), paidAt: daysAgo(70) }),
];

function fakeBackend(opts: { failGet?: boolean } = {}) {
  const sent: string[] = [];
  const all = [...OPEN, ...PAID];
  const backend: CollectionsBackend = {
    listOpenInvoices: async (max) => OPEN.slice(0, max),
    listCustomerInvoices: async (customerId, max) =>
      all.filter((inv) => inv.customerId === customerId).slice(0, max),
    getInvoice: async (id) => {
      if (opts.failGet) throw new Error("No such invoice: 'in_nope'");
      const found = all.find((inv) => inv.id === id);
      if (!found) throw new Error(`No such invoice: '${id}'`);
      return found;
    },
    sendInvoice: async (id) => {
      sent.push(id);
      return all.find((inv) => inv.id === id) as Invoice;
    },
  };
  return { backend, sent };
}

async function connect(opts: { allowWrites?: boolean; failGet?: boolean } = {}) {
  const { backend, sent } = fakeBackend(opts);
  const audit: AuditEntry[] = [];
  const server = createServer({
    backend,
    allowWrites: opts.allowWrites ?? false,
    audit: (e) => audit.push(e),
    now: () => NOW,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    return { isError: res.isError === true, text, data: res.structuredContent as any };
  };
  return { client, call, sent, audit };
}

test("lists every tool, and only the send tool can write", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "customer_payment_history",
    "list_overdue_invoices",
    "receivables_summary",
    "send_invoice_reminder",
  ]);
  assert.equal(byName.list_overdue_invoices.annotations?.readOnlyHint, true);
  assert.equal(byName.receivables_summary.annotations?.readOnlyHint, true);
  assert.equal(byName.customer_payment_history.annotations?.readOnlyHint, true);
  assert.equal(byName.send_invoice_reminder.annotations?.readOnlyHint, false);
});

test("list_overdue_invoices: oldest first, skips not-yet-due and auto-charge invoices", async () => {
  const { call } = await connect();
  const res = await call("list_overdue_invoices");
  assert.equal(res.isError, false);
  assert.equal(res.data.count, 3);
  assert.deepEqual(res.data.invoices.map((i: any) => i.invoice_id), ["in_E", "in_A", "in_B"]);
  assert.equal(res.data.invoices[0].amount_due, "€900.00");
  assert.equal(res.data.invoices[1].amount_due, "$1,200.00");
  assert.equal(res.data.invoices[1].customer, "Acme Roofing");
  assert.equal(res.data.invoices[1].days_overdue, 45);
});

test("list_overdue_invoices: respects min_days_overdue", async () => {
  const { call } = await connect();
  const res = await call("list_overdue_invoices", { min_days_overdue: 30 });
  assert.deepEqual(res.data.invoices.map((i: any) => i.invoice_id), ["in_E", "in_A"]);
});

test("receivables_summary: aging buckets per currency", async () => {
  const { call } = await connect();
  const res = await call("receivables_summary");
  assert.equal(res.data.open_invoices, 5);
  assert.deepEqual(res.data.currencies.usd, {
    days_31_60: { count: 1, total: "$1,200.00" },
    days_1_30: { count: 1, total: "$350.00" },
    not_yet_due: { count: 2, total: "$580.00" },
  });
  assert.deepEqual(res.data.currencies.eur, { days_over_90: { count: 1, total: "€900.00" } });
});

test("customer_payment_history: how late the customer usually pays", async () => {
  const { call } = await connect();
  const res = await call("customer_payment_history", { customer_id: "cus_B" });
  assert.equal(res.data.paid, 2);
  assert.equal(res.data.open, 1);
  assert.equal(res.data.average_days_paid_after_due, 5);
  assert.equal(res.data.paid_on_time, 1);
  assert.equal(res.data.invoices.length, 3);
});

test("customer_payment_history: rejects an id that isn't a customer id", async () => {
  const { client } = await connect();
  const res = await client
    .callTool({ name: "customer_payment_history", arguments: { customer_id: "robert'); DROP TABLE" } })
    .catch((err: unknown) => ({ rejected: err }));
  assert.ok("rejected" in res || res.isError === true, "bad input must not reach Stripe");
});

test("send_invoice_reminder: blocked while writes are off, and nothing is sent", async () => {
  const { call, sent, audit } = await connect({ allowWrites: false });
  const res = await call("send_invoice_reminder", { invoice_id: "in_B" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Writes are off/);
  assert.deepEqual(sent, []);
  assert.equal(audit.at(-1)?.outcome, "refused");
});

test("send_invoice_reminder: sends an overdue open invoice when writes are on", async () => {
  const { call, sent, audit } = await connect({ allowWrites: true });
  const res = await call("send_invoice_reminder", { invoice_id: "in_B" });
  assert.equal(res.isError, false);
  assert.equal(res.data.sent, true);
  assert.equal(res.data.days_overdue, 5);
  assert.deepEqual(sent, ["in_B"]);
  assert.equal(audit.at(-1)?.outcome, "ok");
});

test("send_invoice_reminder: refuses invoices that aren't open or aren't overdue", async () => {
  const { call, sent } = await connect({ allowWrites: true });
  const notDue = await call("send_invoice_reminder", { invoice_id: "in_C" });
  assert.equal(notDue.isError, true);
  assert.match(notDue.text, /isn't overdue yet/);
  const paid = await call("send_invoice_reminder", { invoice_id: "in_F" });
  assert.equal(paid.isError, true);
  assert.match(paid.text, /is paid, not open/);
  assert.deepEqual(sent, []);
});

test("a Stripe failure comes back as a tool error and gets audited", async () => {
  const { call, audit } = await connect({ allowWrites: true, failGet: true });
  const res = await call("send_invoice_reminder", { invoice_id: "in_nope" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Stripe call failed/);
  assert.equal(audit.at(-1)?.outcome, "error");
});

test("checkKey: test keys pass, live keys and junk are refused", () => {
  assert.equal(checkKey("sk_test_abc123"), "sk_test_abc123");
  assert.equal(checkKey("rk_test_abc123"), "rk_test_abc123");
  assert.throws(() => checkKey("sk_live_abc123"), /Refusing a live Stripe key/);
  assert.throws(() => checkKey("rk_live_abc123"), /Refusing a live Stripe key/);
  assert.throws(() => checkKey("hello"), /doesn't look like a Stripe test key/);
  assert.throws(() => checkKey(undefined), /STRIPE_API_KEY is not set/);
});
