import Stripe from "stripe";

/** The invoice fields the tools need, flattened out of Stripe's object. */
export interface Invoice {
  id: string;
  number: string | null;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  /** Minor units (cents for USD). */
  amountDue: number;
  amountPaid: number;
  currency: string;
  /** draft | open | paid | uncollectible | void */
  status: string;
  /** Unix seconds. Null when Stripe charges the card automatically. */
  dueDate: number | null;
  paidAt: number | null;
  created: number;
  hostedInvoiceUrl: string | null;
}

/**
 * Everything the server does to Stripe goes through this interface, so the
 * tests can swap in a fake and never touch the network.
 */
export interface CollectionsBackend {
  listOpenInvoices(max: number): Promise<Invoice[]>;
  listCustomerInvoices(customerId: string, max: number): Promise<Invoice[]>;
  getInvoice(invoiceId: string): Promise<Invoice>;
  /** Re-sends the invoice email to the customer. */
  sendInvoice(invoiceId: string): Promise<Invoice>;
}

function toInvoice(i: Stripe.Invoice): Invoice {
  const customerId =
    typeof i.customer === "string" ? i.customer : (i.customer?.id ?? "");
  return {
    id: i.id ?? "",
    number: i.number ?? null,
    customerId,
    customerName: i.customer_name ?? null,
    customerEmail: i.customer_email ?? null,
    amountDue: i.amount_due,
    amountPaid: i.amount_paid,
    currency: i.currency,
    status: i.status ?? "unknown",
    dueDate: i.due_date ?? null,
    paidAt: i.status_transitions?.paid_at ?? null,
    created: i.created,
    hostedInvoiceUrl: i.hosted_invoice_url ?? null,
  };
}

async function collect(
  pages: AsyncIterable<Stripe.Invoice>,
  max: number,
): Promise<Invoice[]> {
  const out: Invoice[] = [];
  for await (const inv of pages) {
    out.push(toInvoice(inv));
    if (out.length >= max) break;
  }
  return out;
}

export function stripeBackend(apiKey: string): CollectionsBackend {
  const stripe = new Stripe(apiKey, { appInfo: { name: "stripe-collections-mcp" } });
  return {
    listOpenInvoices: (max) =>
      collect(stripe.invoices.list({ status: "open", limit: 100 }), max),
    listCustomerInvoices: (customerId, max) =>
      collect(stripe.invoices.list({ customer: customerId, limit: 100 }), max),
    getInvoice: async (id) => toInvoice(await stripe.invoices.retrieve(id)),
    sendInvoice: async (id) => toInvoice(await stripe.invoices.sendInvoice(id)),
  };
}
