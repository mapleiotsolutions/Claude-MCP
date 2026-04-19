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
      case "get_inventory_for_sku":
        result = await getInventoryForSku(args);
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
