---
name: i118-order-routine
description: Stateful i118 Phone Assistant order-processing routine with isolated workflow namespaces, token-owned renewable claims, local persistence, and safe batching. Use for bounded read-only review in ChatGPT or durable local processing in Claude Code and Codex.
license: Apache-2.0
compatibility: Claude Code, ChatGPT, and Codex. Requires a supported skill runtime with Node.js and shell execution, an active i118 Phone Assistant account with Mcp role, and OAuth authorization to https://mcp.i118.ai/mcp. Durable local state requires Claude Code or Codex on the same machine; hosted ChatGPT state is session-scoped.
---

# Stateful Order Processing Routine

This skill manages continuous, idempotent i118 Phone Assistant order-processing routines. The MCP tools are read-only.
Execute a downstream write only when the user separately authorizes that action.

## 1. Runtime And Workflow Boundaries

- **Claude Code and local Codex:** durable state is available on the current machine.
- **Hosted ChatGPT:** state is not guaranteed across chats, devices, or hosted runtimes. Keep the routine bounded to the
  active read-only workflow unless durable state is supplied by the i118 backend.
- **Different machines:** local files do not coordinate. Use a transactional backend lease when workers must cooperate
  across machines.

Every local routine has a stable `I118_STATE_NAMESPACE`:

- `orders` is the backward-compatible default. It uses `~/.i118/plugin/` and preserves existing order state.
- Any other valid namespace uses `~/.i118/plugin/routines/<namespace>/`.
- Workers performing the **same logical routine** must use the same namespace so they coordinate.
- Unrelated routines must use different namespaces. For example, use `orders` for order review and `pos-entry` for a
  separate downstream-entry workflow. Their cursors, claims, locks, backups, and ledgers remain independent.
- Namespace names must be 1–64 lowercase ASCII letters, numbers, dots, underscores, or hyphens, beginning with a
  letter or number. Uppercase is rejected so names cannot collide unexpectedly on case-insensitive filesystems.

Do not use worker names as workflow namespaces. A namespace identifies the routine; a claim token identifies ownership
of one order inside that routine.

## 2. Durable Local Layout

```text
~/.i118/plugin/                         # I118_STATE_NAMESPACE=orders (default)
├── state.lock
├── order_state.json
├── order_state.json.bak
├── order_history.jsonl
└── routines/
    └── pos-entry/                      # I118_STATE_NAMESPACE=pos-entry
        ├── state.lock
        ├── order_state.json
        ├── order_state.json.bak
        └── order_history.jsonl
```

Directories are owner-only (`0700`) and files are owner-only (`0600`). Each namespace has its own atomic lock,
per-organization state, rolling backup, and append-only ledger.

## 3. State Engine Commands

Resolve `scripts/state_engine.js` relative to this skill. In Claude Code its absolute path is
`${CLAUDE_PLUGIN_ROOT}/skills/i118-order-routine/scripts/state_engine.js`. The examples use `<engine>` for that path.
Pass the same `I118_STATE_NAMESPACE` on every command in one routine.

```bash
# Read the organization's cursor and deduplication state.
I118_STATE_NAMESPACE=orders node "<engine>" get-filter <subOrganizationId>

# Claim before any downstream work. The response includes a private claimToken.
I118_STATE_NAMESPACE=orders node "<engine>" claim <orderId> <createdAtTimestamp> <subOrganizationId> [workerName]

# Extend the five-minute lease while work continues.
I118_STATE_NAMESPACE=orders node "<engine>" renew <orderId> <subOrganizationId> <claimToken>

# Commit only after the authorized action succeeds.
I118_STATE_NAMESPACE=orders node "<engine>" commit <orderId> <createdAtTimestamp> <subOrganizationId> <claimToken>

# Release only the claim owned by this token after failure or an intentional skip.
I118_STATE_NAMESPACE=orders node "<engine>" release <orderId> <subOrganizationId> <claimToken>

I118_STATE_NAMESPACE=orders node "<engine>" status <subOrganizationId>
I118_STATE_NAMESPACE=orders node "<engine>" reset <subOrganizationId>
```

Treat the claim token as internal state: retain it until commit or release, pass it verbatim, and never show it to the
user or write it to a report. An unexpired claim rejects every competing worker, including one with the same worker
name. `commit`, `renew`, and `release` reject missing, expired, or mismatched tokens.

Renew before the lease expires and after every long downstream step. If a single external operation can run longer
than five minutes without an opportunity to renew, local lease coordination cannot prevent duplicate side effects;
split the work into renewable steps or use a backend coordinator with fencing support.

## 4. Execution Flow

### Step 1: Select The Namespace And Read State

Choose one stable namespace for the logical workflow before fetching orders. The standard order processor uses
`orders`. A separate workflow such as POS entry uses its own namespace even when it reads the same i118 orders.

Run `get-filter` for the target organization. It returns
`{ startDate, organizationId, lastProcessedOrderId, processedOrderIds, inFlightOrderIds }`.

### Step 2: Fetch Oldest First And Drain Every Page

Call:

```text
get_orders(subOrganizationId, sort: "oldest", startDate: filter.startDate, pageSize: 25)
```

`sort` is required and must be `oldest`. Leave `includeTotalCount` at its default `false`. Process the returned page in
order, and while `hasMore` is true, pass the exact `nextStartOrderId` as `startOrderId`. Hold `sort`, `startDate`,
`endDate`, and `searchText` fixed for the whole drain because the cursor is bound to those filters.

The inclusive `startDate` may return the last completed order again. Filter it through `processedOrderIds`; re-reading
one order is safe, while advancing beyond unfinished work is not.

### Step 3: Claim Each Candidate

For each record:

1. Skip IDs already in `processedOrderIds` or `inFlightOrderIds`.
2. Run `claim` with the selected namespace.
3. Continue only when `claimed` is `true`.
4. Retain the returned claim token privately for this order.

Workers may fetch the same page. The atomic claim decides which worker owns each order.

### Step 4: Perform Only The Authorized Action

- Extract the required fields from `customerRequest`.
- In Claude Code or local Codex, execute only the downstream action the user authorized.
- In hosted ChatGPT, keep the workflow read-only: inspect and summarize without submitting, creating, cancelling,
  sending, or modifying anything in another service.
- Renew the claim before expiry while local work remains active.

### Step 5: Commit Or Release With The Claim Token

Commit immediately after the action succeeds. On failure or an intentional skip, release the claim. Release clears
lease ownership but retains an unresolved retry marker, so a newer completion cannot advance the high-water mark past
that older unprocessed order. Expired claims remain the same kind of cursor barrier until reclaimed and committed.
Never commit an order whose downstream result is unknown. When the older order eventually commits, the cursor advances
through already completed newer work.

### Step 6: Report Without Internal IDs Or Tokens

Order IDs, organization IDs, cursors, namespace plumbing, processed-ID arrays, and claim tokens stay internal. Report
an order by number plus business day, customer, and store name, with the returned order URL linked on the number. Say
“12 orders processed, 2 still in flight” rather than listing internal identifiers.

## 5. Scaling And Recovery

- `startDate` limits steady-state queries to the unprocessed range; drain a real backlog page by page.
- Each namespace retains a rolling window of 1,000 processed IDs in its active snapshot.
- Each namespace keeps success events and durable per-organization reset boundaries in its own append-only ledger.
- Version 1.2 state is migrated in place to version 1.3 without dropping per-organization progress.
- Valid success-ledger entries reconcile onto primary and backup snapshots, removing stale claims for work already
  committed. Malformed ledger lines are ignored individually without discarding other valid successes.
- A reset appends its generation boundary before replacing the snapshot. Reconciliation ignores older successes for
  that organization, so a crash or backup restore cannot resurrect reset state; other organizations and namespaces
  remain untouched.
- If both snapshots are unavailable, ledger recovery restores deduplication conservatively without advancing the
  cursor past work it cannot prove completed.
- Local namespaces coordinate only processes sharing the same filesystem path. Cross-device or cross-host processing
  requires server-side transactional claims, leases, heartbeats, and idempotent completion receipts.

See [reference.md](references/reference.md) for schemas, lock behavior, lease ownership, and recovery details.
