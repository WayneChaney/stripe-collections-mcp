import { readFileSync } from "node:fs";
import { stripeBackend } from "../dist/src/backend.js";
const key = (readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^STRIPE_API_KEY=(.*)$/m)?.[1] ?? "").trim();
if (!/^(rk|sk)_test_/.test(key)) { console.error("not a test key"); process.exit(1); }
const now = Date.now() / 1000;
const open = await stripeBackend(key).listOpenInvoices(50);
for (const i of open) console.log(i.number, "|", i.customerName, "|", "$" + i.amountDue / 100, "|", Math.floor((now - i.dueDate) / 86400), "days late");
console.log(open.length, "open");
