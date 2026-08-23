# i118 Phone Assistant Plugin — Agent & Project Guide

This document is the primary context file for AI coding assistants working in this repository. Read this before making any changes.

---

## What This Repository Is

This is the **i118 Phone Assistant Plugin** — a unified AI plugin package for **Claude Code** and **OpenAI ChatGPT / Codex**. It connects AI assistants to [i118 Phone Assistant](https://i118.ai), which manages phone orders for restaurants and businesses.

The plugin is **not an application**. It is a configuration & skill bundle: plugin manifests, MCP server config, Agent Skills, and a concurrency state manager. No framework, no build step.

---

## Repository Layout

```text
.claude-plugin/plugin.json     # Anthropic Claude plugin manifest (name, version, skills, MCP)
.codex-plugin/plugin.json      # OpenAI ChatGPT / Codex plugin manifest
.mcp.json                      # MCP server connection config (URL, auth type)
AGENTS.md                      # This file — project context for AI assistants
README.md                      # Human-readable documentation and quickstart
LICENSE                        # Apache-2.0
agents/
  i118-order-processor.md      # Subagent definition for batch order processing
skills/
  i118-orders/
    SKILL.md                   # How to use the 5 MCP tools (whoami, get_suborganizations, get_suborganization, get_orders, get_order)
    reference.md               # Full JSON schemas for all tool payloads
  i118-order-routine/
    SKILL.md                   # Stateful batch processing, concurrency locking, disaster recovery
    reference.md               # State file schemas, lock lifecycle, ledger format
    scripts/
      state_engine.js          # Zero-dependency Node.js concurrency & state helper
  i118-setup/
    SKILL.md                   # Setup, account switching, and connection diagnostics
```

Per the [Agent Skills specification](https://agentskills.io/specification), a skill directory owns its own `scripts/`,
`references/`, and `assets/`. `state_engine.js` therefore lives inside `i118-order-routine`, the skill that documents
it, so the skill stays self-contained if a host ingests only `skills/`. Reference it as `scripts/state_engine.js`
relative to that skill, or `${CLAUDE_PLUGIN_ROOT}/skills/i118-order-routine/scripts/state_engine.js` absolutely.

---

## MCP Server

- **Current / production URL**: `https://mcp.i118.ai/mcp`
- **Auth**: OAuth 2.0 (Clerk CIMD)
- **Config files**: `.mcp.json` (Claude), `.codex-plugin/plugin.json` (ChatGPT)

When changing environments, update the URL in **both** `.mcp.json` and `.codex-plugin/plugin.json`.

---

## The 5 MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `whoami` | Returns the authenticated user's name and email |
| `get_suborganizations` | Lists all organizations owned by the caller, each with an app `url` |
| `get_suborganization` | Returns organization metadata, mirror IDs, and an app `url` for one organization; it does not expose settings or a time zone |
| `get_orders` | Queries orders with ISO 8601 UTC date filters, optional `searchText`, and cursor pagination. **Requires `sort`** (`newest` or `oldest`, no default). Default `pageSize: 25`, max `100`. `totalCount` is opt-in via `includeTotalCount` (default `false`) |
| `get_order` | Returns one order by `id` — the **same object** `get_orders` already returns, not a richer form of it |

---

## State Management

State lives under `~/.i118/plugin/` (user home directory, not the project directory). The backward-compatible
`I118_STATE_NAMESPACE=orders` routine uses the root; independent routines use their own nested namespace:

```text
~/.i118/plugin/
  order_state.json         # Per-organization active snapshots and cursors
  order_state.json.bak     # Rolling backup of previous healthy state
  order_history.jsonl      # Append-only audit ledger of all processed orders
  state.lock               # Token-owned advisory concurrency lock
  routines/
    pos-entry/             # Independent I118_STATE_NAMESPACE=pos-entry state
      order_state.json
      order_state.json.bak
      order_history.jsonl
      state.lock
```

The `skills/i118-order-routine/scripts/state_engine.js` helper manages atomic reads/writes, per-organization in-flight
claims, renewable claim tokens, and rolling 1,000-ID compaction. Workers in the same logical routine use the same
namespace; unrelated routines must use different namespaces. `commit`, `renew`, and `release` require the claim token
returned by `claim`. Directories use mode `0700` and files use `0600`. Local Claude Code and Codex use durable state
on one machine. Hosted ChatGPT state is not guaranteed across chats or devices, and local files never coordinate
different machines.

---

## Skill Naming Convention

All skills are prefixed with `i118-` to prevent collisions with generic skills:
- `i118-orders`
- `i118-order-routine`
- `i118-setup`

---

## Agents

| Agent | File | Purpose |
| :--- | :--- | :--- |
| `i118-order-processor` | `agents/i118-order-processor.md` | Batch processes new i118 Phone Assistant orders: reads state, fetches orders, deduplicates, executes downstream actions, commits state |

**Claude Code only.** The OpenAI plugin format has no agent concept — a plugin there may contain skills, an MCP
server, or both — so `agents/` is not part of the ChatGPT/Codex submission and `.codex-plugin/plugin.json` declares
no agents key. This is not a gap to fill.

Keep the agent additive, never load-bearing: it is a pre-wired autonomous runner over `i118-orders` and
`i118-order-routine`, and every step it performs must also be written out in those skills, which is how ChatGPT and
Codex users reach the same capability. Do not move routine logic out of a skill and into the agent, and do not have a
skill instruct the model to invoke the agent — that instruction is dead outside Claude Code. Note that "agent" in the
`i118-order-routine` docs means any concurrent worker session, not this subagent.

---

## Key Conventions

- **Plugin version** follows semantic versioning in both manifest files (currently `1.0.0`). Bump on any notable change.
- **Default page size** for `get_orders` is `25` (clamped 1–100).
- **`get_orders` requires an explicit `sort`** (`newest` or `oldest`) with no default. Browsing uses `newest`; the order-processing routine uses `oldest` with a `startDate` high-water mark and drains every page. Ordering is not cosmetic here — a newest-first backlog query silently skips the oldest pending orders.
- **`totalCount` is opt-in.** `get_orders` omits it unless the call passes `includeTotalCount: true`, which costs an extra count query over the whole matching range. Use it only when the user asks how many orders there are; never during a backlog drain.
- **`orderNumber` is a display number, not an ID.** It is computed per business day and resets at the organization's configured 3:00 AM boundary, so it is unique only within one organization-day. The MCP does not expose that time zone. `get_order` accepts the order's `id`; use the chat user's local/device zone automatically when resolving a repeated "order #N" by date range.
- **Every order and organization carries a `url`** into the app (`/print?printId=…`, `/app/home?orgId=…`). Surface it to the user, and use the returned value rather than constructing the address.
- **`get_orders` already returns the complete order.** Its entries are the same object `get_order` returns — same fields, same nested `customerRequest`, same `url`. It is not a preview, and `get_order` adds nothing. Do not call `get_order` for an order just received from `get_orders`. It is for two cases: holding an `id` without the record (from routine state, or supplied by the user), or refreshing a copy old enough that a later edit would change the answer — records carry an `UpdatedAt` and can change after being fetched.
- **The record is an "order", never a "print".** `print` / `printId` are internal legacy names that survive only inside the order `url`. They must not appear in user-facing text, table headers, or descriptions of the link. Attaching the `url` as a markdown link rather than pasting it keeps the word off screen.
- **The order link is the only route to the call recording.** The app page behind an order's `url` hosts call-recording playback; recording data is stripped from every tool payload. Offer the link when the text summary leaves a question about what was actually said, and never imply the recording itself has been heard.
- **Automatically use the chat user's time zone.** The MCP does not expose an organization time zone, but the assistant uses the chat user's local/device zone for ordinary order timestamps and ambiguous date filters, labels that zone, and does not ask the user to repeat it. Every customer-facing order timestamp must include the local date, local time, and time zone; raw UTC is tool-only unless the user explicitly requests it. The exception is an appointment: use its returned `meetingTimeLocal` with `customerTimezone` when both are present; that customer zone does not apply to unrelated order timestamps or filters.
- **IDs never reach the user.** `id`, `orderId`, `subOrganizationId`, `organizationId`, and `nextStartOrderId` are plumbing for tool calls, cursors, and state files. User-facing prose, tables, and run summaries identify an order by its number plus day and its customer, and an organization by its `name` — with the record's `url` as a markdown link on that number or name, never a bare pasted URL. The only exceptions are a user explicitly asking for an ID, or an error report that genuinely needs one to diagnose. Any skill or agent that formats output for a human must carry this rule.
- **Skill files** use YAML frontmatter (`name`, `description`, `license`, `compatibility`) followed by markdown instructions.
- **Do not store state** inside the project directory. Runtime state goes under `~/.i118/plugin/`; use
  `I118_STATE_NAMESPACE` to isolate unrelated routines and reserve `orders` for the backward-compatible default.
- **Validate** after any manifest change: `claude plugin validate . --strict`
