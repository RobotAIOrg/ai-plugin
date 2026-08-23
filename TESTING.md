# i118 Phone Assistant Plugin Testing

This document records the repository validation and live client checks performed against the production MCP endpoint.
The live checks used the actual Claude Code and Codex CLIs with the installed plugin; they did not call the MCP server
through an SDK test harness. Reports intentionally omit organization IDs, order IDs, cursors, OAuth codes, tokens,
customer phone numbers, addresses, and raw order URLs.

## Local validation

Run from the plugin repository root:

```bash
node --test tests/*.test.js
claude plugin validate . --strict
git diff --check
```

The August 22-23, 2026 final validation passed all 45 Node tests and the strict Claude plugin validator. Coverage
includes:

- both plugin manifests, the shared production MCP URL, all three skills, the Claude order-processing agent, and all
  five published read-only tools;
- marketplace prompt/tool alignment, complete `get_orders` reuse, direct `get_order` equivalence, totals, valid and
  invalid cursor behavior, automatic local-time-zone handling, tenant non-enumeration, and mutation refusal;
- same-routine multi-process claim exclusion, process-liveness-aware stale-lock recovery, token-owned renew/commit/
  release, crash recovery, lifetime-ledger deduplication after snapshot compaction, and owner-only file permissions;
- independent `I118_STATE_NAMESPACE` state for unrelated workflows on one machine, organization-scoped reset, and a
  reset ledger boundary that prevents a crash or later reconciliation from resurrecting cleared state.

### Agent-specific scope

The Claude `i118-order-processor` subagent definition was checked by the strict plugin validator, and its underlying
`i118-orders` / `i118-order-routine` skills, MCP tools, and state engine were exercised by the live Claude matrix and
local tests. A separate real Claude Task invocation was also completed with Sonnet/low effort using the production
OAuth connection and an isolated temporary state root: it found the first organization with orders, read its state,
fetched one oldest-first page, claimed one candidate, released it without committing, and performed no downstream
write. The temporary verification state was reset afterward.

Codex has no separate `agents` manifest concept: `.codex-plugin/plugin.json` publishes skills and MCP servers only.
Codex therefore tests the equivalent routine through its skills and CLI tool calls, not through a distinct Codex agent.

### Required test inventory

The release check has five required layers. The commands and matrices in this document are the complete local and
live inventory. The marketplace JSON is intentionally a smaller reviewer-facing subset: its schema requires exactly
five positive cases and three negative cases, so it cannot represent every local test.

1. Run all repository tests with `node --test tests/*.test.js`. The individual test names remain in the executable
   test files so this document cannot drift from the suite.
2. Run `claude plugin validate . --strict` and `git diff --check`.
3. Run all eight marketplace cases from `chatgpt-app-submission.json` through fresh Claude Code CLI processes.
4. Run those eight cases plus the two supplemental local cases below through fresh Codex CLI processes.
5. Run the real home-directory namespace smoke check below when the state-engine behavior or documentation changes.

For a focused rerun of the multi-process and independent-state coverage:

```bash
node --test \
  --test-name-pattern='second active claim|several concurrent|concurrent claimers|live lock holder|separate namespaces|reset removes only' \
  tests/state_engine.test.js
```

### Real home-directory state check

The state engine was also exercised against the real `~/.i118/plugin/` root rather than a temporary test directory.
Dedicated `codex-verification-orders` and `codex-verification-pos` namespaces were used; the normal `orders` namespace
was not changed.

- the first worker claimed and renewed an order in `codex-verification-orders`;
- a second worker in that namespace was rejected as already in flight;
- the same order was independently claimable in `codex-verification-pos`;
- commit and release affected only their selected namespaces;
- organization-scoped reset cleared both verification snapshots while recording durable reset boundaries;
- the root, routines directory, and namespace directories were `0700`, while snapshots and ledgers were `0600`.

Repeat this check only with dedicated verification namespaces; never point it at the default `orders` namespace.
The values below are synthetic state-engine identifiers and do not call or mutate the production MCP service:

```bash
state_engine=skills/i118-order-routine/scripts/state_engine.js
verification_org=verification-org
verification_order=verification-order
verification_created_at=2026-01-01T00:00:00Z

# Make the smoke check repeatable after an interrupted or earlier run.
I118_STATE_NAMESPACE=codex-verification-orders node "$state_engine" reset "$verification_org"
I118_STATE_NAMESPACE=codex-verification-pos node "$state_engine" reset "$verification_org"

orders_claim=$(I118_STATE_NAMESPACE=codex-verification-orders node "$state_engine" claim \
  "$verification_order" "$verification_created_at" "$verification_org" worker-orders)
orders_token=$(printf '%s' "$orders_claim" | jq -r '.claimToken')

# Must report in_flight: a second process cannot own the same claim in this namespace.
I118_STATE_NAMESPACE=codex-verification-orders node "$state_engine" claim \
  "$verification_order" "$verification_created_at" "$verification_org" worker-second

# Must succeed: the unrelated namespace owns independent state.
pos_claim=$(I118_STATE_NAMESPACE=codex-verification-pos node "$state_engine" claim \
  "$verification_order" "$verification_created_at" "$verification_org" worker-pos)
pos_token=$(printf '%s' "$pos_claim" | jq -r '.claimToken')

I118_STATE_NAMESPACE=codex-verification-orders node "$state_engine" commit \
  "$verification_order" "$verification_created_at" "$verification_org" "$orders_token"
I118_STATE_NAMESPACE=codex-verification-pos node "$state_engine" release \
  "$verification_order" "$verification_org" "$pos_token"

# Cleanup is scoped to the synthetic organization inside each verification namespace.
I118_STATE_NAMESPACE=codex-verification-orders node "$state_engine" reset "$verification_org"
I118_STATE_NAMESPACE=codex-verification-pos node "$state_engine" reset "$verification_org"
```

## Repeating the marketplace live matrix

[`chatgpt-app-submission.json`](chatgpt-app-submission.json) is the source of truth for the **eight reviewer-facing
cases**: exactly five positive cases and exactly three negative cases. Run every entry from both arrays without
shortening the prompts, because several cases test prompt-level safeguards such as explicit organization selection,
hidden IDs, and avoiding unapproved mutations.

The full local live matrix has ten cases. In addition to the eight marketplace cases, run these two supplemental
cases. They stay in this document because they provide useful regression coverage but do not fit the submission
schema's five-positive-case limit:

1. **Complete `get_orders` reuse.** "Using i118 Phone Assistant and the organization named Test, fetch the newest
   order page and present the full details of the first returned order using only the `get_orders` result. Do not call
   `get_order`, and do not expose internal IDs."
2. **Fresh substring search.** "Using i118 Phone Assistant and the organization named Test, fetch the newest order
   page, choose a non-sensitive substring from the returned request summary or item text, then start a fresh search
   with that substring. Report whether it matched without exposing internal IDs or cursor values."

The ten-case full matrix is therefore:

1. authenticated identity and organization discovery;
2. required organization choice for a generic order request when multiple organizations exist;
3. explicit-organization date filtering in oldest-first order;
4. explicit-organization lookup without claiming settings or a time zone;
5. direct `get_order` equivalence, opt-in totals, and unchanged-filter pagination;
6. foreign-tenant non-enumeration;
7. changed-filter cursor rejection;
8. mutation refusal with no i118 tool call;
9. complete-order presentation from `get_orders` without redundant `get_order`; and
10. fresh substring search scoped to an explicitly selected organization.

Before a run:

1. Confirm the production endpoint in `.mcp.json` and `.codex-plugin/plugin.json` is
   `https://mcp.i118.ai/mcp`.
2. Run the local validation commands above.
3. Authenticate the intended reviewer account and confirm MCP access is enabled.
4. Use a fresh, non-persistent CLI process for each marketplace prompt so earlier answers cannot satisfy a later
   case from conversation context.

List the eight marketplace prompts without exposing any live result data:

```bash
jq -r '.test_cases[].user_prompt, .negative_test_cases[].user_prompt' chatgpt-app-submission.json
```

Run each supplemental prompt separately in a fresh process with the same model, effort, plugin, and sandbox options
as the marketplace loop. Do not add them back to `chatgpt-app-submission.json`.

### Claude Code CLI

Authenticate once when needed:

```bash
claude mcp login i118
```

Then run every marketplace prompt independently with the local plugin, Sonnet, and low effort:

```bash
jq -r '.test_cases[].user_prompt, .negative_test_cases[].user_prompt' chatgpt-app-submission.json |
while IFS= read -r prompt; do
  claude -p \
    --plugin-dir . \
    --model sonnet \
    --effort low \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    "$prompt"
done
```

### Codex CLI

Complete the registered-client OAuth setup below first. Confirm the intended plugin version is installed with
`codex plugin list`, then run each prompt in a fresh ephemeral process:

```bash
jq -r '.test_cases[].user_prompt, .negative_test_cases[].user_prompt' chatgpt-app-submission.json |
while IFS= read -r prompt; do
  codex exec \
    --ephemeral \
    --json \
    --sandbox read-only \
    -C "$PWD" \
    -m gpt-5.4 \
    -c 'model_reasoning_effort="low"' \
    "$prompt"
done
```

For each client, compare the response and tool trace with that case's `tools_triggered` and `expected_output` fields.
In particular, verify that the complete-detail case does not call `get_order`, the tenant security case calls
`get_orders` exactly once, and the mutation case calls no i118 tool. Do not retain raw CLI traces in the repository:
they can contain customer information and internal IDs. Record only a sanitized PASS/FAIL matrix like the ones below.

## Live Claude Code matrix

Environment: Claude Code CLI, installed local plugin checkout, Sonnet with low reasoning, production OAuth MCP.
OAuth was completed through Clerk using the authorized Claude client and the DevRopes reviewer account.

| Case | Result |
| --- | --- |
| Authenticated identity and organization discovery | PASS |
| Newest-first order browsing | PASS |
| Yesterday in oldest-first order with the reviewer's local time zone | PASS |
| Complete detail answered from `get_orders` without a redundant `get_order` call | PASS |
| Organization lookup without a settings or time-zone claim | PASS |
| Direct `get_order` equivalence with the complete `get_orders` record | PASS |
| Opt-in total, unchanged-filter continuation, and fresh substring search | PASS |
| Foreign-tenant request returns only generic `Not found.` | PASS |
| Cursor reused with changed sort is rejected | PASS |
| Order cancellation is refused without a tool call | PASS |

Result: **10/10 PASS**.

## Live Codex matrix

Environment: Codex CLI `0.149.0`, installed i118 plugin `1.0.0`, GPT-5.4 with low reasoning, production OAuth MCP.
The plugin was installed from the local checkout, and each run used `codex exec`; no MCP SDK was used.

| Case | Result |
| --- | --- |
| `whoami`, organization discovery, and a one-order diagnostic read | PASS |
| Newest-first order browsing and pagination availability | PASS |
| Yesterday in oldest-first order with the reviewer's local time zone | PASS |
| Complete detail answered from `get_orders` with no `get_order` call for that case | PASS |
| Organization lookup without a settings or time-zone claim | PASS |
| Direct `get_order` equivalence with the complete `get_orders` record | PASS |
| Opt-in total, unchanged-filter continuation, and fresh substring search | PASS |
| Exactly one foreign-tenant query returns only generic `Not found.` | PASS |
| Cursor reused after changing only `sort` is rejected with a fresh-search requirement | PASS |
| Order cancellation is refused without an i118 tool call | PASS |

Result: **10/10 PASS**.

The live dataset's newest record did not always contain a customer name or item. For the substring capability case,
Codex selected a substring from the available request summary, which is part of the documented search surface.

## Codex OAuth development setup

The production Clerk instance allows only pre-registered OAuth clients, so Codex CIMD is not sufficient unless its
CIMD client is separately allow-listed. The verified local-development fallback is a Clerk public OAuth application
using Authorization Code with PKCE and an exact loopback redirect URI.

Codex chooses an ephemeral loopback port unless `mcp_oauth_callback_port` is pinned. For the verified run, the port
was pinned to `1455`, and the registered URI used the callback path printed by `codex mcp login`. Register the exact
URI emitted by the installed Codex CLI; the callback suffix is client-instance-specific and should not be copied from
another developer's machine.

The Clerk application allowed `openid`, `profile`, `email`, and `offline_access`. The successful login explicitly
limited Codex to those scopes:

```bash
codex -c mcp_oauth_callback_port=1455 mcp login i118 \
  --scopes openid,profile,email,offline_access
```

Two failure modes were verified during setup:

- allowing Codex to request discovered `public_metadata` and `private_metadata` scopes fails when the registered
  Clerk application does not allow them;
- manually setting `--oauth-resource` duplicates the resource already discovered from the MCP metadata in Codex
  `0.149.0`, and Clerk rejects the duplicated parameter. Leave the explicit resource unset for this configuration.

The registered client ID, client secret, authorization codes, and stored tokens must never be committed to this
repository or copied into test reports.
