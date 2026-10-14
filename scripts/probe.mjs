import { readFileSync } from "node:fs";
import Stripe from "stripe";
const key = (readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^STRIPE_API_KEY=(.*)$/m)?.[1] ?? "").trim();
const s = new Stripe(key);
for await (const cl of s.testHelpers.testClocks.list({limit:10})) {
  for await (const c of s.customers.list({limit:10, test_clock: cl.id})) {
    let k=0; for await (const i of s.invoices.list({limit:10, customer: c.id})) k++;
    console.log("clock cust", c.name, "invoices via customer filter:", k);
  }
}
const c = await s.customers.create({ name: "Probe Co", email: "probe@example.test" });
try { const inv = await s.invoices.create({ customer: c.id, collection_method: "send_invoice", due_date: Math.floor(Date.now()/1000) - 30*86400, auto_advance:false }); console.log("past due_date OK"); await s.invoices.del(inv.id); }
catch (e) { console.log("past due_date refused:", e.raw?.message); }
await s.customers.del(c.id);
