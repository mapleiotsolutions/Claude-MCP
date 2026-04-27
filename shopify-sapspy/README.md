# shopify-sapspy MCP server

MCP server exposing a Shopify store's catalog, orders, and customers to Claude
via the Model Context Protocol.

## Configuration

Required env vars (read from `.env` next to `index.js`, OS env wins):

- `SHOPIFY_STORE` — store handle, e.g. `my-store` (the part before `.myshopify.com`)
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Optional:

- `SHOPIFY_API_VERSION` — defaults to `2025-01`

The server uses the `client_credentials` grant to fetch and auto-refresh an
Admin API access token.

## Required Shopify Admin API access scopes

Grant these scopes to the custom app whose client ID/secret are configured above.
Tools that require write scopes are noted; everything else is read-only.

| Scope | Used by |
| --- | --- |
| `read_products` | `search_products`, `get_product`, `list_collections`, `get_products_in_collection`, `get_inventory_for_sku` |
| `read_orders` | `search_orders`, `get_unpaid_orders`, `get_order`, `search_orders_full` |
| `write_orders` | `record_order_payment` |
| `read_customers` | `list_customers`, `get_customer`, and the customer block on order detail |
| `write_customers` | `update_customer_email_marketing_consent` |
| `read_assigned_fulfillment_orders` | `get_order`, `search_orders_full` (fulfillment + tracking data) |

If your store assigns fulfillments to merchant-managed or third-party fulfillment
services, you may also need `read_merchant_managed_fulfillment_orders` and/or
`read_third_party_fulfillment_orders` to see those fulfillments on order detail.

## Tools

Catalog: `search_products`, `get_product`, `list_collections`,
`get_products_in_collection`, `get_inventory_for_sku`.

Orders (summary): `search_orders`, `get_unpaid_orders`.

Orders (full detail, for invoicing / mailing): `get_order`, `search_orders_full`.
These return line items with per-line discount allocations, structured billing
and shipping addresses, money totals (including `outstandingAmount` and a
`shippingDiscounted` flag), tax lines, transactions, and fulfillments with
tracking. `search_orders_full` is cursor-paginated — pass back the returned
`pageInfo.endCursor` as `cursor` to walk the result set.

Order mutations: `record_order_payment` (full balance via
`orderMarkAsPaid`; partial via `orderCreateManualPayment`, which requires
Shopify Plus).

Customers: `list_customers`, `get_customer`,
`update_customer_email_marketing_consent`.
