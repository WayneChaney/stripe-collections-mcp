// Seeds a Stripe TEST account with invented, overdue invoices for the demo.
// Refuses to run on a live key. Never prints the key.
//
//   node scripts/seed-demo.mjs
//
// Stripe won't create an invoice that is already past due, so this makes a
// test clock frozen ~100 days ago, attaches the customers to it, and issues
// invoices with net-N terms. Their due dates land in the real past.
import { readFileSync } from "node:fs";
import Stripe from "stripe";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (env.match(/^STRIPE_API_KEY=(.*)$/m)?.[1] ?? "").trim();
if (!/^(rk|sk)_test_/.test(key)) {
  console.error("Refusing: STRIPE_API_KEY is missing or not a TEST key.");
  process.exit(1);
}
const stripe = new Stripe(key);

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const clockStart = now - 100 * DAY;

// name, amount in dollars, net days (due = clockStart + net)
const book = [
  ["Juniper Ridge Landscaping", 2480, 10],  // ~90 days late
  ["Harbor Bay Plumbing", 1350, 35],        // ~65 days late
  ["Cedar Hollow Electric", 920, 55],       // ~45 days late
  ["Silver Lake Roofing", 3175, 75],        // ~25 days late
  ["Pine Valley HVAC", 640, 92],            // ~8 days late
  ["Harbor Bay Plumbing", 780, 30],         // a second late one, for payment history
];

// Clean out any earlier demo clocks (deleting a clock deletes its customers).
for await (const c of stripe.testHelpers.testClocks.list({ limit: 100 })) {
  if (c.name?.startsWith("collections demo")) await stripe.testHelpers.testClocks.del(c.id);
}
// Stripe allows 3 customers per test clock, so hand out a fresh clock every 3.
let clock = null;
let onClock = 0;
const nextClock = async () => {
  clock = await stripe.testHelpers.testClocks.create({
    frozen_time: clockStart,
    name: "collections demo",
  });
  onClock = 0;
};

const customers = new Map();
for (const [name, dollars, net] of book) {
  let cust = customers.get(name);
  if (!cust) {
    if (!clock || onClock >= 3) await nextClock();
    onClock++;
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");
    cust = await stripe.customers.create({
      name,
      email: `billing@${slug}.example.com`,
      test_clock: clock.id,
    });
    customers.set(name, cust);
  }
  const inv = await stripe.invoices.create({
    customer: cust.id,
    collection_method: "send_invoice",
    days_until_due: net,
    auto_advance: false,
  });
  await stripe.invoiceItems.create({
    customer: cust.id,
    invoice: inv.id,
    amount: dollars * 100,
    currency: "usd",
    description: "Monthly service",
  });
  const fin = await stripe.invoices.finalizeInvoice(inv.id, { auto_advance: false });
  const late = Math.floor((now - fin.due_date) / DAY);
  console.log(`${fin.number}  ${name}  $${dollars}  ${late} days late`);
}
console.log("done");
