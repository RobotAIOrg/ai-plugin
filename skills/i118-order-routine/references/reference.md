# i118 Phone Assistant Routine State And Concurrency Reference

## Runtime Scope And Namespace Isolation

Local Claude Code and Codex routines coordinate through filesystem state on one machine. Hosted ChatGPT storage is
not a durable cross-chat queue, and separate machines do not share these local leases.

`I118_STATE_NAMESPACE` selects the logical workflow:

| Namespace | State directory |
| :--- | :--- |
| unset or `orders` | `~/.i118/plugin/` |
| `jobs` | `~/.i118/plugin/routines/jobs/` |
| `pos-entry` | `~/.i118/plugin/routines/pos-entry/` |

Use the same namespace for workers that should share claims. Use different stable namespaces for routines whose
progress must remain independent, even when they read the same organization and order records. `I118_STATE_DIR` may
override the root for tests or controlled installations; namespace isolation still applies below that root. Names
are lowercase-only so case-sensitive and case-insensitive filesystems resolve them consistently.

## 1. File Specifications

Each namespace owns these four durable files. Directories use mode `0700`; files use mode `0600`. A transient
`state.lock.breaker` serializes recovery of a dead stale lock.

### `order_state.json`

```json
{
  "version": "1.3",
  "namespace": "orders",
  "organizationResetTokens": {
    "org_cleared": "private-random-reset-token"
  },
  "organizations": {
    "org_abc123": {
      "lastProcessedOrderId": "ord_105",
      "lastProcessedCreatedAt": "2026-08-20T12:30:00.000Z",
      "lastRunAt": "2026-08-20T13:00:00.000Z",
      "inFlightOrders": {
        "ord_106": {
          "claimToken": "private-random-claim-token",
          "claimedBy": "worker-one",
          "claimedAt": "2026-08-20T13:00:10.000Z",
          "createdAt": "2026-08-20T12:35:00.000Z",
          "expiresAt": "2026-08-20T13:05:10.000Z"
        }
      },
      "processedOrderIds": ["ord_101", "ord_105"],
      "processedOrderCreatedAt": {
        "ord_101": "2026-08-20T12:20:00.000Z",
        "ord_105": "2026-08-20T12:30:00.000Z"
      },
      "processedClaimTokenHashes": {
        "ord_101": "sha256-completion-receipt",
        "ord_105": "sha256-completion-receipt"
      }
    }
  }
}
```

The claim token is the ownership credential. `claimedBy` is informational and may be a human-readable worker label;
two workers with the same label are still different unless they hold the same token. Version 1.2 snapshots migrate
to 1.3 on the next mutation while retaining organizations, cursors, processed IDs, and claims. A legacy in-flight
claim without a token cannot be committed or released and must expire before being reclaimed.

`inFlightOrders` also retains released or expired entries as ownership-free retry markers. Those entries are omitted
from `get-filter.inFlightOrderIds`, so another worker may reclaim them, but they continue to block the cursor from
skipping the older unprocessed order.

### `order_state.json.bak`

Before each active-state replacement, the previous healthy snapshot is copied to this rolling backup. The new active
snapshot is written to an owner-only unique temporary file and atomically renamed into place.

### `state.lock`

The engine creates this file atomically with `openSync(..., "wx")`:

```json
{
  "lockToken": "private-random-lock-token",
  "pid": 12345,
  "time": "2026-08-20T13:00:10.123Z"
}
```

Every command waits up to five seconds for the namespace lock. The stale threshold is 30 seconds and is measured from
filesystem `mtime`, not the JSON timestamp. A stale lock is recovered only while holding the separate atomic breaker
and only when its recorded process is no longer alive; a live holder is not evicted merely because 30 seconds elapsed.
An abandoned breaker is itself recoverable under the same age and process-liveness rules, so a crash during stale-lock
recovery does not permanently block the namespace.
A holder removes the lock only when the on-disk lock token still matches its own token, preventing an old holder from
deleting a newer replacement lock.

The lock coordinates only processes that resolve the same namespace to the same local filesystem. It is not a
distributed lock and should not be placed on a network filesystem without separately validating that filesystem's
exclusive-create and atomic-rename guarantees.

### `order_history.jsonl`

```json
{"orderId":"ord_101","organizationId":"org_abc123","createdAt":"2026-08-20T12:20:00Z","processedAt":"2026-08-20T13:00:01Z","claimTokenHash":"sha256-completion-receipt","status":"success"}
{"organizationId":"org_cleared","resetAt":"2026-08-20T14:00:00Z","resetToken":"private-random-reset-token","status":"reset"}
```

Each namespace has an independent append-only event ledger. Success events are the lifetime deduplication authority;
the snapshot keeps only the latest 1,000 successes for efficient filtering. A SHA-256 claim-token receipt permits an
idempotent commit retry to authenticate without persisting the private token itself.

A reset event is a durable generation boundary for one organization in one namespace. Reconciliation ignores that
organization's success events before its newest reset and records the reset token in `organizationResetTokens`. This
prevents an older success ledger or backup from resurrecting the cleared organization, including when the process
crashes after appending the reset but before replacing the snapshot. Later successes remain eligible normally. Reset
events for one organization never clear another organization, and a reset in one namespace never affects another
namespace. Internal IDs, receipts, and reset tokens remain local and must not appear in the human run summary.

## 2. Token-Owned Lease Lifecycle

1. `claim <orderId> <createdAt> <organizationId> [workerName]` takes the namespace lock. If the order is processed or
   has any unexpired claim, it returns `claimed:false`. Otherwise it stores a random claim token and a five-minute
   expiry and returns the token to the caller.
2. The worker retains that claim token privately while it performs the user-authorized action.
3. `renew <orderId> <organizationId> <claimToken>` extends the active lease by five minutes. Missing, expired, and
   mismatched tokens fail closed.
4. `commit <orderId> <createdAt> <organizationId> <claimToken>` succeeds only for the active owner. It durably appends
   success and its token hash before replacing the snapshot, then moves the order into the processed window, removes
   the claim, advances the safe cursor, and refreshes the backup. A retry after an interrupted snapshot write succeeds
   only with the original token.
5. `release <orderId> <organizationId> <claimToken>` clears only the caller's ownership and retains a retry marker at
   the original timestamp.
6. After release or expiry, a different worker may claim the order. Until it commits, the retry marker remains a
   cursor barrier so a newer completion cannot skip it.

Renew before expiry and between long steps. A local lease cannot fence a stale worker out of an external service that
does not understand the token. For exactly-once side effects across machines or operations longer than one renewable
step, use a backend transaction/lease plus an idempotency or fencing key accepted by the downstream system.

## 3. Cursor Safety And Recovery

- Completion of a newer order does not move the cursor past an older active, released, or expired claim.
- When the older order is reclaimed and committed, the cursor may advance through already completed newer orders.
- `startDate` remains inclusive; `processedOrderIds` removes the harmless boundary duplicate.
- The active snapshot retains the latest 1,000 processed IDs per organization, while claims check the lifetime ledger
  so compaction cannot make an older completed order eligible again.
- Snapshot envelopes and field types are validated before use; structurally invalid JSON falls back to the backup.
- Valid ledger successes reconcile onto any loaded snapshot, restoring processed IDs and clearing stale matching
  claims. Each ledger line is parsed independently.
- The newest reset event for an organization is applied before success reconciliation, so only successes after that
  generation boundary can restore state.
- If the primary snapshot is unreadable, the reconciled backup is restored without overwriting it with corruption.
- If both snapshots are unavailable, the ledger reconstructs processed IDs but deliberately leaves the cursor unset;
  a success ledger cannot prove that every older order completed.

## 4. Independent Workflow Example

Two processes may inspect the same incoming order for different purposes without sharing progress:

```bash
I118_STATE_NAMESPACE=orders node "<engine>" get-filter <organizationId>
I118_STATE_NAMESPACE=pos-entry node "<engine>" get-filter <organizationId>
```

Those processes use different directories and never see each other's claims or processed IDs. Two workers jointly
draining `pos-entry` must both use `I118_STATE_NAMESPACE=pos-entry`; their token-owned claims then divide the work.
