# stripe-collections-mcp

[![CI](https://github.com/WayneChaney/stripe-collections-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WayneChaney/stripe-collections-mcp/actions/workflows/ci.yml)

Ask Claude who owes you money, and let it chase only the invoices you've cleared it to chase.

## Results

- 11 tests passing. 4 tools: 3 read tools and 1 write tool with a gate.
- Safety checks: live key refused, writes off by default, re-check before send, audit log.
- Cost to run: $0 locally with Stripe test mode.

An MCP server that connects Stripe to Claude, ChatGPT, or any MCP client. It reads your open invoices, works out who's late and by how much, and can re-send an overdue invoice to the customer. It starts read-only, and sending stays off until you turn it on.

## Demo

![Claude asks who owes money, the server answers, and a reminder only goes out after you allow it](docs/demo.gif)

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_overdue_invoices` | Open invoices past their due date, oldest first: who owes it, how much, how many days late, their payment link | No |
| `receivables_summary` | Everything owed, grouped into not yet due / 1–30 / 31–60 / 61–90 / over 90 days, per currency | No |
| `customer_payment_history` | A customer's recent invoices and how many days late they usually pay | No |
| `send_invoice_reminder` | Re-sends an overdue invoice email through Stripe | Only with `ALLOW_WRITES=true` |

## Safety

- **Test mode only.** A live Stripe key stops the server before it connects to anything.
- **Read-only by default.** `send_invoice_reminder` refuses to run unless the server was started with `ALLOW_WRITES=true`.
- **It re-checks before it sends.** The invoice has to still be open and actually overdue, or nothing goes out.
- **Every call is logged.** One JSON line per tool call, reads included, in `~/.stripe-collections-mcp/audit.jsonl`. Set `AUDIT_LOG` to move it, or `AUDIT_LOG=off` to turn it off.
- **Bad input never reaches Stripe.** Customer and invoice ids are validated first.
- **Use a restricted key.** In Stripe, create a restricted key with Invoices: Read and Customers: Read. Add Invoices: Write only if you turn sending on.

## Why the guardrails

- An agent that can send money-related emails needs a hard off switch.
- Invoice state can change between a recommendation and a send, so the server checks again before it sends.
- An audit trail makes each tool call reviewable.

## Run it

Needs Node 20 or newer. Clone the repo, then:

```bash
npm install
```

`npm install` builds it. The server lives at `dist/src/index.js`.

**Claude Desktop:** add this to `claude_desktop_config.json`, then restart Claude.

```json
{
  "mcpServers": {
    "stripe-collections": {
      "command": "node",
      "args": ["/absolute/path/to/stripe-collections-mcp/dist/src/index.js"],
      "env": {
        "STRIPE_API_KEY": "rk_test_...",
        "ALLOW_WRITES": "false"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add stripe-collections -e STRIPE_API_KEY=rk_test_... -- node /absolute/path/to/stripe-collections-mcp/dist/src/index.js
```

## Try it

- "Who owes me money right now?"
- "How much is more than 60 days late?"
- "How late does this customer usually pay?"
- "Send a reminder for every invoice more than 30 days late." (Needs `ALLOW_WRITES=true`. Your client will still ask before each send unless you've auto-approved the tool.)

## Tests

```bash
npm test
```

11 tests call every tool through a real MCP client against a fake Stripe, so they never touch the network. They cover the sort order, the aging buckets, the late-payment math, sending blocked while writes are off, refusing invoices that are paid or not due yet, Stripe errors coming back as tool errors, and the live-key guard.

## How it's built

- `src/backend.ts`: the only file that talks to Stripe. It flattens Stripe's invoice into the fields the tools need.
- `src/server.ts`: the four tools, the aging math, and the write gate.
- `src/safety.ts`: the test-mode key check and the audit log.
- `src/index.ts`: stdio entry point. Logs go to stderr because stdout carries the protocol.

Swapping Stripe for another billing API means rewriting `backend.ts` and nothing else.

---

Built by Vanwayne Chaney. I build custom MCP servers that connect your API to Claude and ChatGPT.
