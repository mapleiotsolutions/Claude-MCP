#!/usr/bin/env node
/**
 * Shopify Admin MCP Server
 *
 * Exposes a Shopify store's catalog and orders to Claude via Model Context Protocol.
 * Uses client_credentials grant to fetch (and auto-refresh) an Admin API access token.
 *
 * Required env vars:
 *   SHOPIFY_STORE          e.g. "my-store" (the part before .myshopify.com)
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 *
 * Optional env vars:
 *   SHOPIFY_API_VERSION    defaults to "2025-01"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load .env from this server's directory, if present.
// OS env vars take precedence — they're never overwritten.
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key]) continue;
    process.env[key] = rawVal.replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {
  // .env is optional
}

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing required env vars: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET"
  );
  process.exit(1);
}

const GRAPHQL_URL = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
const TOKEN_URL = `https://${STORE}.myshopify.com/admin/oauth/access_token`;

// ------------------------- token management -------------------------

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  // Refresh 60s before expiry
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ------------------------- graphql helper -------------------------

async function gql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// ------------------------- tool implementations -------------------------

function compactProduct(p) {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    priceRange: p.priceRangeV2
      ? {
          min: p.priceRangeV2.minVariantPrice?.amount,
          max: p.priceRangeV2.maxVariantPrice?.amount,
          currency: p.priceRangeV2.minVariantPrice?.currencyCode,
        }
      : undefined,
    totalInventory: p.totalInventory,
    url: `https://${STORE}.myshopify.com/products/${p.handle}`,
  };
}

async function searchProducts({ query = "", limit = 10 }) {
  const q = `
    query($query: String, $first: Int!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id title handle status vendor productType tags totalInventory
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
          }
        }
      }
    }
  `;
  const data = await gql(q, { query, first: Math.min(limit, 50) });
  return data.products.edges.map((e) => compactProduct(e.node));
}

async function getProduct({ identifier }) {
  // Try handle first, then SKU, then ID
  let query;
  if (identifier.startsWith("gid://")) {
    query = `id:${identifier.replace("gid://shopify/Product/", "")}`;
  } else if (/^\d+$/.test(identifier)) {
    query = `id:${identifier}`;
  } else {
    query = `handle:${identifier} OR sku:${identifier}`;
  }

  const q = `
    query($query: String) {
      products(first: 1, query: $query) {
        edges {
          node {
            id title handle status vendor productType tags totalInventory
            descriptionHtml
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
            featuredImage { url altText }
            variants(first: 50) {
              edges {
                node {
                  id title sku price
                  inventoryQuantity
                  availableForSale
                }
              }
            }
            collections(first: 20) { edges { node { title handle } } }
          }
        }
      }
    }
  `;
  const data = await gql(q, { query });
  const edge = data.products.edges[0];
  if (!edge) return null;
  const p = edge.node;
  return {
    ...compactProduct(p),
    description: p.descriptionHtml?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    featuredImage: p.featuredImage?.url,
    variants: p.variants.edges.map((v) => ({
      id: v.node.id,
      title: v.node.title,
      sku: v.node.sku,
      price: v.node.price,
      inventoryQuantity: v.node.inventoryQuantity,
      availableForSale: v.node.availableForSale,
    })),
    collections: p.collections.edges.map((c) => c.node),
  };
}

async function listCollections({ limit = 50 }) {
  const q = `
    query($first: Int!) {
      collections(first: $first) {
        edges { node { id title handle productsCount { count } } }
      }
    }
  `;
  const data = await gql(q, { first: Math.min(limit, 100) });
  return data.collections.edges.map((e) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    productCount: e.node.productsCount?.count,
  }));
}

async function getProductsInCollection({ collection, limit = 25 }) {
  // collection can be handle or title fragment
  const q = `
    query($query: String, $first: Int!) {
      collections(first: 1, query: $query) {
        edges {
          node {
            id title handle
            products(first: $first) {
              edges {
                node {
                  id title handle status vendor productType tags totalInventory
                  priceRangeV2 {
                    minVariantPrice { amount currencyCode }
                    maxVariantPrice { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await gql(q, {
    query: `handle:${collection} OR title:${collection}`,
    first: Math.min(limit, 50),
  });
  const edge = data.collections.edges[0];
  if (!edge) return null;
  return {
    collection: { title: edge.node.title, handle: edge.node.handle },
    products: edge.node.products.edges.map((e) => compactProduct(e.node)),
  };
}

function compactOrder(o) {
  const numericId = o.id?.replace("gid://shopify/Order/", "");
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    customer: o.customer
      ? {
          name: o.customer.displayName,
          email: o.customer.email,
        }
      : null,
    total: o.totalPriceSet
      ? {
          amount: o.totalPriceSet.shopMoney?.amount,
          currency: o.totalPriceSet.shopMoney?.currencyCode,
        }
      : undefined,
    received: o.totalReceivedSet
      ? {
          amount: o.totalReceivedSet.shopMoney?.amount,
          currency: o.totalReceivedSet.shopMoney?.currencyCode,
        }
      : undefined,
    outstanding: o.totalOutstandingSet
      ? {
          amount: o.totalOutstandingSet.shopMoney?.amount,
          currency: o.totalOutstandingSet.shopMoney?.currencyCode,
        }
      : undefined,
    url: numericId
      ? `https://${STORE}.myshopify.com/admin/orders/${numericId}`
      : undefined,
  };
}

async function searchOrders({ query = "", limit = 25 }) {
  const q = `
    query($query: String, $first: Int!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name createdAt
            displayFinancialStatus displayFulfillmentStatus
            customer { displayName email }
            totalPriceSet { shopMoney { amount currencyCode } }
            totalReceivedSet { shopMoney { amount currencyCode } }
            totalOutstandingSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  `;
  const data = await gql(q, { query, first: Math.min(limit, 100) });
  return data.orders.edges.map((e) => compactOrder(e.node));
}

async function getUnpaidOrders({ limit = 50 }) {
  return searchOrders({ query: "financial_status:unpaid", limit });
}

async function resolveOrder(identifier) {
  // Fetch id, pre-state, currency, and canMarkAsPaid from either a GID or a name (e.g. "#3114").
  const selection = `
    id name
    displayFinancialStatus
    canMarkAsPaid
    totalPriceSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount currencyCode } }
  `;
  if (identifier.startsWith("gid://")) {
    const q = `query($id: ID!) { order(id: $id) { ${selection} } }`;
    const data = await gql(q, { id: identifier });
    return data.order;
  }
  const name = identifier.startsWith("#") ? identifier : `#${identifier}`;
  const q = `
    query($query: String) {
      orders(first: 1, query: $query) { edges { node { ${selection} } } }
    }
  `;
  const data = await gql(q, { query: `name:${name}` });
  return data.orders.edges[0]?.node || null;
}

function summarizeOrderState(o) {
  return {
    financialStatus: o.displayFinancialStatus,
    outstanding: o.totalOutstandingSet
      ? {
          amount: o.totalOutstandingSet.shopMoney?.amount,
          currency: o.totalOutstandingSet.shopMoney?.currencyCode,
        }
      : undefined,
  };
}

async function recordOrderPayment({ orderId, amount, paymentMethodName }) {
  if (!orderId) throw new Error("orderId is required");

  const pre = await resolveOrder(orderId);
  if (!pre) return { error: `Order not found: ${orderId}` };
  if (!pre.canMarkAsPaid) {
    return {
      error: `Order ${pre.name} cannot be marked as paid (current status: ${pre.displayFinancialStatus}, outstanding: ${pre.totalOutstandingSet?.shopMoney?.amount} ${pre.totalOutstandingSet?.shopMoney?.currencyCode}). If it is already PAID or has zero outstanding balance, no action is needed.`,
      order: { id: pre.id, name: pre.name, ...summarizeOrderState(pre) },
    };
  }

  const before = summarizeOrderState(pre);

  if (amount == null) {
    // Full outstanding — orderMarkAsPaid works on all Shopify plans.
    const mutation = `
      mutation($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id name
            displayFinancialStatus
            totalOutstandingSet { shopMoney { amount currencyCode } }
          }
          userErrors { field message }
        }
      }
    `;
    const data = await gql(mutation, { input: { id: pre.id } });
    const res = data.orderMarkAsPaid;
    if (res.userErrors?.length) {
      return { error: res.userErrors.map((e) => e.message).join("; "), userErrors: res.userErrors };
    }
    return {
      order: { id: res.order.id, name: res.order.name },
      mutation: "orderMarkAsPaid",
      appliedAmount: before.outstanding,
      before,
      after: summarizeOrderState(res.order),
    };
  }

  // Partial or specific amount — orderCreateManualPayment (Shopify Plus required for amount field).
  const currency = pre.totalOutstandingSet?.shopMoney?.currencyCode;
  if (!currency) return { error: "Could not determine order currency." };

  const mutation = `
    mutation($id: ID!, $amount: MoneyInput, $paymentMethodName: String) {
      orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $paymentMethodName) {
        order {
          id name
          displayFinancialStatus
          totalOutstandingSet { shopMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }
  `;
  const data = await gql(mutation, {
    id: pre.id,
    amount: { amount: String(amount), currencyCode: currency },
    paymentMethodName: paymentMethodName || null,
  });
  const res = data.orderCreateManualPayment;
  if (res.userErrors?.length) {
    return { error: res.userErrors.map((e) => e.message).join("; "), userErrors: res.userErrors };
  }
  return {
    order: { id: res.order.id, name: res.order.name },
    mutation: "orderCreateManualPayment",
    appliedAmount: { amount: String(amount), currency },
    before,
    after: summarizeOrderState(res.order),
  };
}

async function getInventoryForSku({ sku }) {
  const q = `
    query($query: String) {
      productVariants(first: 10, query: $query) {
        edges {
          node {
            id sku title price
            inventoryQuantity
            availableForSale
            product { id title handle }
          }
        }
      }
    }
  `;
  const data = await gql(q, { query: `sku:${sku}` });
  return data.productVariants.edges.map((e) => ({
    sku: e.node.sku,
    variantTitle: e.node.title,
    price: e.node.price,
    inventoryQuantity: e.node.inventoryQuantity,
    availableForSale: e.node.availableForSale,
    product: e.node.product,
  }));
}

function compactCustomer(c) {
  const numericId = c.id?.replace("gid://shopify/Customer/", "");
  return {
    id: c.id,
    name: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    emailMarketing: c.emailMarketingConsent
      ? {
          state: c.emailMarketingConsent.marketingState,
          optInLevel: c.emailMarketingConsent.marketingOptInLevel,
          consentUpdatedAt: c.emailMarketingConsent.consentUpdatedAt,
        }
      : null,
    tags: c.tags,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    url: numericId
      ? `https://${STORE}.myshopify.com/admin/customers/${numericId}`
      : undefined,
  };
}

async function listCustomers({ query = "", limit = 50, subscribed, cursor } = {}) {
  // Convenience: if `subscribed` is explicitly true/false, translate to Shopify
  // search syntax using email_marketing_state. Merge with any user-supplied query.
  let effectiveQuery = query || "";
  if (subscribed === true) {
    effectiveQuery = [effectiveQuery, "email_marketing_state:SUBSCRIBED"]
      .filter(Boolean)
      .join(" ");
  } else if (subscribed === false) {
    effectiveQuery = [effectiveQuery, "email_marketing_state:UNSUBSCRIBED"]
      .filter(Boolean)
      .join(" ");
  }

  const q = `
    query($query: String, $first: Int!, $after: String) {
      customers(first: $first, query: $query, after: $after, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id displayName firstName lastName email phone tags createdAt updatedAt
            emailMarketingConsent {
              marketingState marketingOptInLevel consentUpdatedAt
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const data = await gql(q, {
    query: effectiveQuery,
    first: Math.min(limit, 250),
    after: cursor || null,
  });
  return {
    customers: data.customers.edges.map((e) => compactCustomer(e.node)),
    hasNextPage: data.customers.pageInfo.hasNextPage,
    endCursor: data.customers.pageInfo.endCursor,
  };
}

async function resolveCustomer(identifier) {
  const selection = `
    id displayName firstName lastName email phone tags note verifiedEmail
    createdAt updatedAt
    emailMarketingConsent {
      marketingState marketingOptInLevel consentUpdatedAt
      sourceLocation { id name }
    }
    defaultAddress { formattedArea }
  `;

  if (identifier.startsWith("gid://")) {
    const q = `query($id: ID!) { customer(id: $id) { ${selection} } }`;
    const data = await gql(q, { id: identifier });
    return data.customer;
  }
  if (/^\d+$/.test(identifier)) {
    const gid = `gid://shopify/Customer/${identifier}`;
    const q = `query($id: ID!) { customer(id: $id) { ${selection} } }`;
    const data = await gql(q, { id: gid });
    return data.customer;
  }
  // Treat as email or phone via customerByIdentifier.
  const identifierInput = identifier.includes("@")
    ? { emailAddress: identifier }
    : { phoneNumber: identifier };
  const q = `
    query($identifier: CustomerIdentifierInput!) {
      customerByIdentifier(identifier: $identifier) { ${selection} }
    }
  `;
  const data = await gql(q, { identifier: identifierInput });
  return data.customerByIdentifier;
}

async function getCustomer({ identifier }) {
  if (!identifier) throw new Error("identifier is required");
  const c = await resolveCustomer(identifier);
  if (!c) return null;
  return {
    ...compactCustomer(c),
    note: c.note,
    verifiedEmail: c.verifiedEmail,
    defaultAddress: c.defaultAddress?.formattedArea,
    emailMarketingSourceLocation: c.emailMarketingConsent?.sourceLocation || null,
  };
}

const VALID_MARKETING_STATES = new Set(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]);
const VALID_OPT_IN_LEVELS = new Set([
  "SINGLE_OPT_IN",
  "CONFIRMED_OPT_IN",
  "UNKNOWN",
]);

async function updateCustomerEmailMarketingConsent({
  customerId,
  marketingState,
  marketingOptInLevel,
  consentUpdatedAt,
}) {
  if (!customerId) throw new Error("customerId is required");
  if (!marketingState) throw new Error("marketingState is required");

  const state = String(marketingState).toUpperCase();
  if (!VALID_MARKETING_STATES.has(state)) {
    return {
      error: `Invalid marketingState '${marketingState}'. Must be one of: SUBSCRIBED, UNSUBSCRIBED, PENDING. (NOT_SUBSCRIBED, REDACTED, and INVALID are read-only and cannot be set via this mutation.)`,
    };
  }

  let optInLevel;
  if (marketingOptInLevel != null) {
    optInLevel = String(marketingOptInLevel).toUpperCase();
    if (!VALID_OPT_IN_LEVELS.has(optInLevel)) {
      return {
        error: `Invalid marketingOptInLevel '${marketingOptInLevel}'. Must be one of: SINGLE_OPT_IN, CONFIRMED_OPT_IN, UNKNOWN.`,
      };
    }
  }

  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  const pre = await resolveCustomer(gid);
  if (!pre) return { error: `Customer not found: ${customerId}` };
  if (!pre.email) {
    return {
      error: `Customer ${pre.displayName || pre.id} has no email address. Shopify requires an email on the customer record before their email marketing consent can be updated.`,
    };
  }

  const before = {
    state: pre.emailMarketingConsent?.marketingState,
    optInLevel: pre.emailMarketingConsent?.marketingOptInLevel,
    consentUpdatedAt: pre.emailMarketingConsent?.consentUpdatedAt,
  };

  const emailMarketingConsent = { marketingState: state };
  if (optInLevel) emailMarketingConsent.marketingOptInLevel = optInLevel;
  if (consentUpdatedAt) emailMarketingConsent.consentUpdatedAt = consentUpdatedAt;

  const mutation = `
    mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $input) {
        customer {
          id email displayName
          emailMarketingConsent {
            marketingState marketingOptInLevel consentUpdatedAt
          }
        }
        userErrors { field message code }
      }
    }
  `;
  const data = await gql(mutation, {
    input: { customerId: gid, emailMarketingConsent },
  });
  const res = data.customerEmailMarketingConsentUpdate;
  if (res.userErrors?.length) {
    return {
      error: res.userErrors.map((e) => e.message).join("; "),
      userErrors: res.userErrors,
      before,
    };
  }
  return {
    customer: {
      id: res.customer.id,
      name: res.customer.displayName,
      email: res.customer.email,
    },
    before,
    after: {
      state: res.customer.emailMarketingConsent?.marketingState,
      optInLevel: res.customer.emailMarketingConsent?.marketingOptInLevel,
      consentUpdatedAt: res.customer.emailMarketingConsent?.consentUpdatedAt,
    },
  };
}

// ------------------------- MCP server wiring -------------------------

const server = new Server(
  { name: "shopify-sapspy", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the Shopify store catalog. Query supports Shopify's search syntax (title, tag, vendor, product_type, sku, status). Returns compact product summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Shopify search query (e.g. 'Hub', 'tag:cranberry', 'status:active', 'title:node'). Empty string returns all active products.",
        },
        limit: { type: "number", description: "Max results (default 10, cap 50)" },
      },
    },
  },
  {
    name: "get_product",
    description:
      "Get full details for one product, including variants, description, collections, and inventory. Identifier can be a handle, SKU, or numeric product ID.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Product handle, SKU, or numeric Shopify ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "list_collections",
    description: "List all collections in the Shopify store with product counts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
    },
  },
  {
    name: "get_products_in_collection",
    description:
      "Get all products in a collection. Pass the collection handle or title fragment.",
    inputSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "Collection handle or title fragment (e.g. 'hub', 'cranberry')",
        },
        limit: { type: "number", description: "Max results (default 25, cap 50)" },
      },
      required: ["collection"],
    },
  },
  {
    name: "search_orders",
    description:
      "Search orders using Shopify's order search syntax. Examples: 'financial_status:unpaid', 'fulfillment_status:unfulfilled', 'email:foo@bar.com', 'created_at:>2026-01-01', 'name:#1042'. Returns compact order summaries sorted newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Shopify order search query. Empty string returns all orders (newest first).",
        },
        limit: { type: "number", description: "Max results (default 25, cap 100)" },
      },
    },
  },
  {
    name: "get_unpaid_orders",
    description:
      "List unpaid orders (financial status: pending, authorized, or partially_paid). Sorted newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
    },
  },
  {
    name: "record_order_payment",
    description:
      "Record a manual payment on a single order (cash, check, bank transfer, etc.). REQUIRES write_orders scope. Operates on one order at a time — no bulk. If `amount` is omitted, marks the full outstanding balance paid via orderMarkAsPaid (works on all Shopify plans). If `amount` is provided, records a partial payment via orderCreateManualPayment (REQUIRES Shopify Plus). Returns before/after financial status and outstanding balance so the caller can verify the effect.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description:
            "Order GID (e.g. 'gid://shopify/Order/123...') or order name (e.g. '#3114'). Required.",
        },
        amount: {
          type: "number",
          description:
            "Optional. The payment amount in the order's currency. Omit to pay the full outstanding balance. Partial amounts require Shopify Plus.",
        },
        paymentMethodName: {
          type: "string",
          description:
            "Optional label for the payment method (e.g. 'Cash', 'Check'). Defaults to 'Other'. Only used when `amount` is provided.",
        },
      },
      required: ["orderId"],
    },
  },
  {
    name: "get_inventory_for_sku",
    description:
      "Look up current inventory and price for a specific SKU. Returns variant-level details.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "The SKU to look up" },
      },
      required: ["sku"],
    },
  },
  {
    name: "list_customers",
    description:
      "List customers, optionally filtered by email marketing subscription state or a Shopify customer search query. Use the `subscribed` flag for the common case of finding who is/isn't opted in to email marketing, or pass `query` for full Shopify search syntax (e.g. 'email_marketing_state:PENDING', 'tag:wholesale', 'country:CA', 'updated_at:>2026-01-01'). Returns compact customer summaries (newest-updated first) with each customer's email marketing state, opt-in level, and last-updated timestamp. REQUIRES read_customers scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional Shopify customer search query. Empty string returns all customers.",
        },
        subscribed: {
          type: "boolean",
          description:
            "Optional shortcut. true → only customers with email_marketing_state=SUBSCRIBED; false → only UNSUBSCRIBED. Omit to return all states. Merged with `query` if both are provided.",
        },
        limit: {
          type: "number",
          description: "Max results (default 50, cap 250).",
        },
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor. Pass the `endCursor` returned by a previous call to fetch the next page. Omit for the first page.",
        },
      },
    },
  },
  {
    name: "get_customer",
    description:
      "Get full details for one customer, including email marketing consent state, opt-in level, consent source location, tags, verified email flag, and default address. Identifier can be a customer GID, numeric customer ID, email address, or phone number. REQUIRES read_customers scope.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description:
            "Customer GID, numeric ID, email address (contains '@'), or phone number (E.164 format, e.g. '+13125551212').",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "update_customer_email_marketing_consent",
    description:
      "Update a customer's email marketing subscription status in Shopify via the customerEmailMarketingConsentUpdate mutation. REQUIRES write_customers scope. The customer must already have an email address on their record. Only three states can be set: SUBSCRIBED (opted in), UNSUBSCRIBED (opted out), or PENDING (double opt-in waiting confirmation). NOT_SUBSCRIBED, REDACTED, and INVALID are read-only internal states and cannot be set. Returns before/after consent state so the caller can verify the change.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description:
            "Customer GID (e.g. 'gid://shopify/Customer/123...') or numeric customer ID. Required.",
        },
        marketingState: {
          type: "string",
          enum: ["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"],
          description:
            "Required. The email marketing state to set. SUBSCRIBED = opt in; UNSUBSCRIBED = opt out; PENDING = awaiting double opt-in confirmation.",
        },
        marketingOptInLevel: {
          type: "string",
          enum: ["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"],
          description:
            "Optional. The opt-in level at the time of consent (per M3AAWG guidelines).",
        },
        consentUpdatedAt: {
          type: "string",
          description:
            "Optional. ISO 8601 datetime of when the customer gave or withdrew consent (e.g. '2026-04-23T14:30:00Z'). Defaults to the time the mutation runs if omitted.",
        },
      },
      required: ["customerId", "marketingState"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "search_products":
        result = await searchProducts(args || {});
        break;
      case "get_product":
        result = await getProduct(args);
        break;
      case "list_collections":
        result = await listCollections(args || {});
        break;
      case "get_products_in_collection":
        result = await getProductsInCollection(args);
        break;
      case "search_orders":
        result = await searchOrders(args || {});
        break;
      case "get_unpaid_orders":
        result = await getUnpaidOrders(args || {});
        break;
      case "record_order_payment":
        result = await recordOrderPayment(args || {});
        break;
      case "get_inventory_for_sku":
        result = await getInventoryForSku(args);
        break;
      case "list_customers":
        result = await listCustomers(args || {});
        break;
      case "get_customer":
        result = await getCustomer(args);
        break;
      case "update_customer_email_marketing_consent":
        result = await updateCustomerEmailMarketingConsent(args || {});
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("shopify-sapspy MCP server running on stdio");
