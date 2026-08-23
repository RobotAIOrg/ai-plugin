# i118 Phone Assistant Orders & Payloads Reference

Detailed JSON contracts and field descriptions for tools provided by `https://mcp.i118.ai/mcp`.

---

## 1. `customerRequest` Schema

The `customerRequest` object is created by i118 Phone Assistant and embedded in every order returned by either tool — `get_orders` and `get_order` return the same object, so neither is a reduced form of the other:

```json
{
  "createdAt": "2026-08-20T12:29:45Z",
  "summary": {
    "en": "Customer ordered 2 Pepperoni Pizzas with extra cheese for delivery.",
    "original": "Customer ordered 2 Pepperoni Pizzas with extra cheese for delivery."
  },
  "customerInfo": {
    "name": "Jane Smith",
    "phone": "+14155552671",
    "email": "jane.smith@example.com",
    "address": "123 Main St, Apt 4B, San Francisco, CA 94105"
  },
  "requestItems": {
    "items": [
      {
        "name": "Pepperoni Pizza",
        "quantity": 2,
        "price": 18.50,
        "options": ["Extra Cheese", "Thin Crust"]
      }
    ],
    "splitBill": null
  },
  "appointment": {
    "meetingTimeUtc": "2026-08-21T18:00:00Z",
    "meetingTimeLocal": "2026-08-21T11:00:00",
    "customerTimezone": "America/Los_Angeles",
    "eventTypeUri": null,
    "appointmentIds": ["apt_9988"]
  }
}
```

---

## 2. Tool Response Payloads

### `whoami`
```json
{
  "name": "Alex Johnson",
  "primaryEmail": "alex@example.com"
}
```

### `get_suborganizations`
```json
{
  "subOrganizations": [
    {
      "id": "org_abc123",
      "name": "Downtown Cafe",
      "url": "https://app.i118.ai/app/home?orgId=org_abc123"
    }
  ]
}
```

### `get_suborganization`
```json
{
  "id": "org_abc123",
  "name": "Downtown Cafe",
  "organizationType": "Restaurant",
  "createdAt": "2026-01-15T08:00:00.0000000Z",
  "cancelAt": null,
  "emailNotificationsEnabled": false,
  "mirrorOrganizationIds": ["org_mirror456"],
  "url": "https://app.i118.ai/app/home?orgId=org_abc123"
}
```

### `get_orders` — request

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `subOrganizationId` | string | **yes** | From `get_suborganizations`. |
| `sort` | `"newest"` \| `"oldest"` | **yes** | No default. `"newest"` for browsing, `"oldest"` with `startDate` for backlog processing. An unrecognized value is treated as `"oldest"`. |
| `startOrderId` | string | no | `nextStartOrderId` from the previous page. Omit for the first page. |
| `startDate` | ISO 8601 UTC | no | Inclusive lower bound. Convert an ambiguous local date/time from the chat user's local/device zone automatically. |
| `endDate` | ISO 8601 UTC | no | Exclusive upper bound. Convert an ambiguous local date/time from the chat user's local/device zone automatically. |
| `searchText` | string | no | Case-insensitive substring match over the customer request. Blank is treated as omitted. |
| `pageSize` | int | no | Defaults to `25`, clamped to `1`–`100`. |
| `includeTotalCount` | bool | no | Defaults to `false`. Set `true` **only** when the user asks how many orders there are; it adds `totalCount` to the response. It costs an extra count query over the whole matching range, and `hasMore` / `nextStartOrderId` already drive pagination without it. |

The cursor is bound to `subOrganizationId`, `sort`, `startDate`, `endDate`, and `searchText`. Changing any of them
while paginating returns `{"error": "The filters changed. Restart without a cursor."}`. Omitting `sort` returns an
error naming both valid values.

```json
{
  "subOrganizationId": "org_abc123",
  "sort": "oldest",
  "startDate": "2026-08-20T00:00:00Z",
  "pageSize": 25
}
```

### `get_orders` — response
```json
{
  "subOrganizationId": "org_abc123",
  "pageSize": 25,
  "count": 1,
  "hasMore": true,
  "nextStartOrderId": "eyJzY29wZSI6ImFiYyIsImlkIjoiMTA1In0=",
  "orders": [
    {
      "id": "ord_105",
      "orderNumber": 7,
      "createdAt": "2026-08-20T12:30:00.0000000Z",
      "organizationId": "org_abc123",
      "url": "https://app.i118.ai/print?printId=ord_105",
      "customerRequest": { ... }
    }
  ]
}
```

| Field | Notes |
| :--- | :--- |
| `count` | Number of orders in **this page**. |
| `totalCount` | **Omitted unless the request passed `includeTotalCount: true`.** Do not expect it otherwise. |
| `hasMore`, `nextStartOrderId` | Pagination. Feed `nextStartOrderId` back as `startOrderId`, unchanged. |
| `id` | The order's stable identifier. This — not `orderNumber` — is what `get_order` accepts. |
| `orderNumber` | Display number only; see [§3 Order Numbering](#3-order-numbering). |
| `url` | Link to this order in the app; see [§4 App Links](#4-app-links). |

With `includeTotalCount: true`, the response carries one extra field:

```json
{
  "subOrganizationId": "org_abc123",
  "pageSize": 25,
  "count": 25,
  "totalCount": 150,
  "hasMore": true,
  "nextStartOrderId": "eyJzY29wZSI6ImFiYyIsImlkIjoiMTA1In0=",
  "orders": [ ... ]
}
```

`totalCount` is the number of orders matching **this same search** across every page. The organization and its mirror
organizations, `searchText`, `startDate`, and `endDate` all narrow it; the cursor and `pageSize` do not, so it stays
the same as you page. It is neither a lifetime total nor the size of the current page — that is `count`.

### `get_order` — response
```json
{
  "order": {
    "id": "ord_105",
    "orderNumber": 7,
    "createdAt": "2026-08-20T12:30:00.0000000Z",
    "organizationId": "org_abc123",
    "url": "https://app.i118.ai/print?printId=ord_105",
    "customerRequest": { ... }
  }
}
```

A missing order and an order owned by someone else both return the same generic `{"error": "Not found."}`, so a
not-found result never tells you whether the order exists.

> [!IMPORTANT]
> **The `order` object here is identical to each entry in the `get_orders` `orders` array.** Both tools build it from
> the same projection — same fields, same nested `customerRequest`, same `url`. `get_orders` is not a truncated
> preview, and `get_order` returns nothing extra.
>
> Consequence: do not call `get_order` for an order you just received from `get_orders`. It is a wasted round trip
> that returns data you are holding. `get_order` is for two cases: you have an `id` without the record (from routine
> state, or supplied by the user), or the copy you hold is old enough that a later edit would change your answer —
> order records carry an `UpdatedAt` and can be modified after you fetch them.

---

## 3. Order Numbering

`orderNumber` is a **display number computed per business day**, not a stable or unique identifier:

- The sequence resets at the organization's configured **3:00 AM** business-day boundary. The MCP does not expose
  that time zone.
- It is unique only within one organization's business day — `#7` recurs every day.
- It is **not** accepted by `get_order`, and `searchText` does not match against it.

To resolve a user's "order #7", ask only for the intended business day when it is ambiguous, then call `get_orders`
with `startDate`/`endDate` in ISO 8601 UTC spanning the chat user's local/device-zone 3:00 AM → 3:00 AM window.
Answer from the matching entry — it is the complete order, so no `get_order` follow-up is needed.

---

## 4. App Links

Every organization and every order comes back with a `url`:

- Orders: `https://app.i118.ai/print?printId=<orderId>`
- Organizations: `https://app.i118.ai/app/home?orgId=<subOrganizationId>`

> [!NOTE]
> The `print` / `printId` in the order address is internal legacy naming. The record is an **order** — never call it a
> print, a print record, or a `printId` when speaking to the user. Attaching the `url` as a markdown link rather than
> pasting it keeps the word off screen.

The order page is also where the **call recording** for that order can be played. Recording data is deliberately
absent from every tool payload — the MCP projection strips all call metadata — so this link is the only route to it.
Offer it whenever the text `summary` leaves a question about what was actually said, and never imply you have heard
the recording yourself.

Pass them through when presenting records so the user has somewhere to look. They are addresses only and carry no
token or secret: opening one still requires a signed-in app session, and an `orgId` naming an organization the browser
user does not own is ignored.

Use the `url` the tool returned rather than assembling one by hand, so the plugin keeps working if the app's address
shape changes.
