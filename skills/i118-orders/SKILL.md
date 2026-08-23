---
name: i118-orders
description: Query and inspect i118 Phone Assistant phone orders, appointments, and customer details using the 5 OAuth MCP tools. Use when retrieving customer requests, searching order history, or verifying account identity.
license: Apache-2.0
compatibility: Claude Code, ChatGPT, and Codex. Requires an active i118 Phone Assistant account with Mcp role and OAuth authorization to https://mcp.i118.ai/mcp.
---

# i118 Phone Assistant Orders

This skill teaches the model how to discover organizations, query i118 Phone Assistant orders, and inspect structured call summaries via the `i118` remote MCP connector (`https://mcp.i118.ai/mcp`).

> [!IMPORTANT]
> The five published i118 MCP tools are strictly read-only. They cannot create, cancel, send, print, dispatch, or
> modify an order. When a user asks the plugin to perform one of those mutations, do not ask for organization, order,
> or action parameters and do not imply it could work with more details. Explain the read-only boundary and offer to
> inspect or summarize existing records instead. A separately authorized downstream workflow is outside this MCP
> tool surface and must follow the `i118-order-routine` boundary.

---

## 1. The 5 OAuth MCP Tools Quick Reference

| Tool | Inputs | Purpose |
| :--- | :--- | :--- |
| `whoami` | None | Verify authenticated user's name and primary email. |
| `get_suborganizations` | None | List all organizations owned by the caller. |
| `get_suborganization` | `subOrganizationId` | Fetch an organization record. It does not expose organization settings or a time zone. |
| `get_orders` | `subOrganizationId`, **`sort`** (required), `startOrderId`, `startDate`, `endDate`, `searchText`, `pageSize`, `includeTotalCount` | Page through orders newest-first or oldest-first, with ISO 8601 UTC date filtering, substring search, and scoped cursors. |
| `get_order` | `orderId` | Retrieve one order by `id`. Returns the **same object** `get_orders` already gives you — use it only when you have an `id` without the record. |

For detailed JSON schemas and full object payloads, see [reference.md](references/reference.md).

---

## 2. Core Operational Procedures

### A. Identity & Organization Discovery
Before querying orders, always ensure you have the target `subOrganizationId`:
1. Call `whoami` to verify session credentials.
2. Call `get_suborganizations` to list available organizations.
3. If exactly one organization is available, use it.
4. If more than one organization is available and the user has not explicitly named one, **stop and ask the user
   which organization to query by name before calling `get_orders`**. Do not silently choose the first organization,
   the first organization with orders, or an arbitrary organization.
5. If the user explicitly asks for orders across all organizations, confirm that scope and query each organization
   deliberately, labeling results by organization name. Otherwise, do not list orders until the user chooses one.

### B. Querying Orders (`get_orders`)
- **Sort (required)**: `get_orders` has no default ordering — every call must pass `sort`. See *Choosing a sort direction* below.
- **Page Size**: Defaults to `25` orders per page (supports `1` to `100`). Which orders land on the first page depends entirely on `sort`.
- **Date Filtering**: `get_orders` accepts UTC timestamps only. Interpret a relative or calendar-only request such
  as “today”, “yesterday”, “August 14”, or “after 3 PM” in the **chat user's local/device time zone** automatically,
  without asking the user. Convert that local interval to UTC for the tool call. If the user supplies an explicit zone
  or UTC offset, it overrides the chat-user zone. The MCP does not expose an organization time zone; the automatic
  zone comes from the chat/client context, never an organization setting or another order's appointment.
  - `startDate` is inclusive; `endDate` is exclusive.
- **Search**: `searchText` is an optional case-insensitive substring match against the order's customer request — use it to find an order by customer name or item instead of paging blindly.
- **Pagination**:
  - If `hasMore` is `true`, pass the exact `nextStartOrderId` string into `startOrderId` for the next page.
  - **Do not modify filters** (`sort`, `startDate`, `endDate`, `searchText`, `subOrganizationId`) when using a cursor; cursors are cryptographically bound to the query filter hash. Changing any of them returns `"The filters changed. Restart without a cursor."`
- **Unauthorized or unknown records**: Preserve non-enumeration. Return a generic not-found explanation without
  saying whether a foreign tenant exists. Never print internal IDs while suggesting accessible alternatives; names
  alone are sufficient.
- **Counting (`includeTotalCount`)**: Leave it `false` (the default) for browsing and paging — the response then has **no** `totalCount` field, and `hasMore`/`nextStartOrderId` are what drive pagination. Set it `true` only when the user actually asks *how many* orders there are (e.g. "how many orders did we get yesterday?"), because it runs a second count query over the entire matching range. `totalCount` is the size of that same search across all pages: the organization and its mirrors, `searchText`, and the date range narrow it, while the cursor and `pageSize` do not, so it does not change as you page. It is not a lifetime total, and it is not the size of the current page — that is `count`.

#### Choosing a sort direction

| Situation | Use | Why |
| :--- | :--- | :--- |
| "Show me my recent orders", "what came in today", browsing | `sort: "newest"` | The first page is the most recent orders, which is what the user is asking to see. |
| Processing a backlog, working a queue, "process all new orders" | `sort: "oldest"` **with `startDate`** | Orders are worked first-in-first-out, and the first page is the earliest orders on or after `startDate`. |

> [!WARNING]
> Do not use `sort: "oldest"` without a `startDate` unless the user genuinely wants the earliest orders in retained
> history — it returns the oldest records in the whole range, not recent ones.

> [!WARNING]
> Do not use `sort: "newest"` for backlog processing. When more orders are waiting than fit in one page, the oldest
> ones never appear on the first page, and a routine that advances a high-water mark will skip them permanently. See
> the `i118-order-routine` skill.

If `sort` is omitted, the tool returns an error naming both valid values rather than guessing a direction.

### C. Inspecting Customer Requests

Each order object — from **either** tool — carries the full `customerRequest`. Extract:
- **`customerInfo`**: Customer's full name, phone number, and delivery address.
- **`requestItems`**: Items ordered, quantities, unit prices, and custom options.
- **`appointment`**: Scheduled meeting/service time (UTC & local) and timezone.
- **`summary`**: Clean natural language summary of the customer's phone conversation.

> [!IMPORTANT]
> **`get_orders` already returns the complete order.** Its summaries are the same object `get_order` returns — same
> fields, same nested `customerRequest`, nothing withheld or truncated. There is no "detail" call to follow up with.
>
> So if the order is already in a `get_orders` result you have, **answer from it**. Calling `get_order` on an order
> you just listed spends a round trip to receive data you are already holding.

Call `get_order` in exactly two situations:

1. **You have an `id` but not the record** — an ID from stored routine state, or one the user supplied.
2. **The copy you hold may be stale and the staleness matters.** Order records carry an `UpdatedAt` and can change
   after you fetch them. In a long session, if the listing is old and the user is asking something a later edit would
   have changed, re-fetch that one order rather than reporting from an earlier result. Judge this by
   whether a change would alter your answer — not by reflex.

It takes the order's `id`, never its `orderNumber`; if the user names an order by its `#` number, see
*Resolving "order #N"* below.

### D. Resolving "order #N"
`orderNumber` is a **per-business-day display number**, not an identifier. It restarts at `1` at the organization's
configured 3:00 AM boundary, so `#7` recurs every single day and is not unique. The MCP does not expose that time
zone.

To answer "pull up order #7":
1. Determine which business day the user means (default to today's; if genuinely ambiguous, ask). Use the chat user's
   local/device time zone automatically unless the user supplied an explicit zone.
2. Call `get_orders` with `startDate`/`endDate` in ISO 8601 UTC covering that zone's 3:00 AM → 3:00 AM window.
3. Find the order whose `orderNumber` matches and answer from it. **Do not follow up with `get_order`** — you already
   have the complete record.

Never pass an `orderNumber` to `get_order`, and never assume `#105` means an order from 105 orders ago —
`searchText` does not match order numbers either.

---

## 3. Formatting Guidelines

### Never surface raw IDs
`id`, `orderId`, `subOrganizationId`, `organizationId`, and `nextStartOrderId` are plumbing. They are for tool calls,
cursors, and state files — **not** for anything the user reads. A user who asked about their orders does not want
`ord_105` or `org_abc123` in the answer; those strings are noise they cannot act on.

Refer to records the way the user does:

| Instead of | Say |
| :--- | :--- |
| `ord_105` | **Order #7** (today's), or "Jane Smith's 12:30 PM order" |
| `org_abc123` | **Downtown Cafe** — the `name` from `get_suborganizations` |
| "cursor `eyJzY29wZS…`" | "there are more orders — want to see more?" |

Rules:
- Resolve an organization ID to its `name` before mentioning it. If you only have the ID, call
  `get_suborganizations` or `get_suborganization` to get the name rather than showing the ID.
- Link, don't paste. Put the record's `url` on the order number or store name as a markdown link
  (`[Order #7](https://app.i118.ai/print?printId=…)`). A bare pasted URL puts the ID back on screen as text.
- Never narrate pagination internals. Say "there are more orders" or "there are no more matching orders", not the
  `nextStartOrderId` value. **Do not say “page”, “pages”, “pagination”, “cursor”, or “continuation” to the customer.**
- Two exceptions, and only these: the user explicitly asks for an ID, or you are reporting a tool error where the ID
  is genuinely needed to diagnose it.

This is a presentation rule only. Keep using IDs normally inside tool arguments, `state_engine.js` commands, and
deduplication state — just keep them out of prose, tables, and summaries.

### Call it an order, never a "print"
The record is an **order**. "Print" and `printId` are internal legacy vocabulary that survive only inside the `url`
(`/print?printId=…`) — they are not what this thing is called. Never say "print", "print record", or "printId" to the
user, never label a table column that way, and never describe opening the link as "viewing the print". Because the
rule above says to attach the `url` as a markdown link rather than pasting it as text, the word stays hidden where it
belongs.

The same goes for other backend-side words that appear in payload field names but are not user language: say
"order", "store" or "location", and "customer request" or "call".

### The order link includes the call recording
The `url` opens the order in the app, where **call recording playback** is available for that order. The
recording is deliberately *not* in any tool payload — the MCP projection strips all call metadata — so the link is the
only way for the user to reach it.

That makes the link worth offering unprompted whenever a user asks anything the transcript or summary only partly
answers: what the customer actually said, a disputed item, an unclear address, a tone or wording question. Offer it as
what it is ("you can listen to the call from the order"), and never imply you have listened to the recording
yourself or can quote it — you have only the text `summary`.

### Use only time zones the MCP provides
Order timestamps (`createdAt`) are UTC. Convert and present them in the **chat user's local/device time zone**, and
label that zone. Do not present that zone as an organization setting.

**Mandatory rendering rule:** For every customer-facing order timestamp, you **MUST show both the local date and time
and the time zone** — for example, `Aug 13, 2026, 7:42 PM PDT`. Never display a raw UTC timestamp, a date without a
time, or a time without a date unless the user explicitly asks for UTC or asks for only one component. UTC is for tool
arguments and internal conversion, not ordinary customer-facing order results.

An appointment is more specific: when `customerRequest.appointment.customerTimezone` and `meetingTimeLocal` are
present, present that appointment in the **customer's time zone** and label it with `customerTimezone`. Otherwise use
the returned `meetingTimeUtc`, labeled "UTC". Use `customerTimezone` only to answer an appointment-specific time
question; it does not establish a time zone for unrelated order timestamps or date-range filtering.

This is not cosmetic. The business day — and therefore an order's `orderNumber` — rolls over at the organization's
configured 3:00 AM boundary (see §2D), but the MCP does not expose that zone. Use the chat user's local/device zone
for the date range rather than deriving a zone from an order or appointment.

If appointment time-zone data is absent or cannot be resolved, do not guess: show `meetingTimeUtc` and label it
"UTC". An honest UTC timestamp is always better than a confidently wrong local one.

### Presenting orders
- Present orders in a structured table with Order #, Timestamp, Customer Name, Phone, and Item Summary.
- Include the record's **`url`** as a link on the order number (or store name) whenever orders or organizations are
  listed — every order and organization comes back with one, and it gives the user somewhere to click through to. Use
  the returned `url` verbatim; do not build the address yourself.
- When showing an order number, note the day it belongs to if it is not obviously today's — the number alone does not
  identify an order across days.
- Highlight any special dietary restrictions, delivery notes, or appointment dates.
