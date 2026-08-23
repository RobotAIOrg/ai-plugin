# i118 Phone Assistant Plugin

An AI plugin for **Claude Code** and **OpenAI ChatGPT / Codex** that connects to [i118 Phone Assistant](https://i118.ai).

---

## 🌟 Conversational Capabilities

In a supported Claude Code, ChatGPT, or Codex conversation, interact naturally in chat:

* **Query & Search Orders**:
  > *"Show me our newest phone orders from today with customer names and items."*
  > *"Pull up today's order #7 and show me the customer's delivery address and special notes."*
  > *"How many orders did we take yesterday?"*
* **Batch Order Routines**:
  > *"Review new orders and prepare a portal-entry summary for each unprocessed order."*
  > *"Continue from where we left off and fetch the next 25 orders."*
* **Organization & Account Check**:
  > *"Which i118 Phone Assistant organizations and stores do I have access to?"*
  > *"Check my i118 Phone Assistant connection and test my setup."*

---

## 🚀 Setup by Environment

### 1. Claude Code (CLI)
1. Install or load the plugin:
   ```bash
   claude --plugin-dir .
   ```
2. Log into your i118 Phone Assistant account:
   ```bash
   claude mcp login i118
   ```

### 2. ChatGPT (published app)
1. Find **i118 Phone Assistant** in the ChatGPT app directory and install it.
2. Select **Connect** when ChatGPT prompts you, then complete the i118 Phone Assistant sign-in and consent flow in your browser.
3. In a new chat, ask: *"Check my i118 Phone Assistant connection."*

The published app supplies its own MCP connection and OAuth configuration. Users do **not** need to configure an MCP URL.

### 3. Codex
Install the i118 Phone Assistant plugin from its configured marketplace, then complete the i118 Phone Assistant authorization prompt. The plugin manifest supplies the MCP endpoint; do not manually add a separate MCP connection.

For a local plugin-development install, source changes do not automatically reload into an already-open Codex chat. Update/reinstall the plugin and start a new chat before retesting authentication or tool discovery.

> [!NOTE]
> Claude Desktop, Claude Cowork, Claude.ai, and Claude mobile use their own connector configuration and availability rules. This repository's Claude Code plugin manifest does not install the i118 Phone Assistant skills or state helper into those surfaces.

---

## 🔄 Switching Between i118 Phone Assistant Business Accounts

> [!NOTE]
> Switching accounts refers to switching **which i118 Phone Assistant business account** is linked to Claude or ChatGPT. You **never** need to sign out of your Claude or OpenAI account.

If you manage multiple i118 Phone Assistant business accounts and want to switch which one is connected:

1. **Sign out in the i118 Phone Assistant Web Portal**:
   Open your browser, go to **[https://app.i118.ai](https://app.i118.ai)**, click your user profile, and choose **Sign Out**.
2. **Sign in to the new i118 Phone Assistant Account**:
   Log into your desired new account at **[https://app.i118.ai](https://app.i118.ai)** (and ensure MCP is enabled at **[https://app.i118.ai/app/mcp](https://app.i118.ai/app/mcp)**).
3. **Reconnect in your AI Client**:
   * **Claude Desktop**: Settings -> Connectors -> Click **Disconnect**, then click **Connect to Claude**.
   * **Claude Code (CLI)**: Run `claude mcp logout i118` then `claude mcp login i118`. If you need to discard the previous account's local order cursor, run `I118_STATE_NAMESPACE=orders node "${CLAUDE_PLUGIN_ROOT}/skills/i118-order-routine/scripts/state_engine.js" reset <subOrganizationId>`. Reset other workflow namespaces separately when applicable.
   * **ChatGPT**: Disconnect **i118 Phone Assistant** from ChatGPT's Apps or Connected Apps settings, then reconnect it from the app directory and re-authorize.
   * **Codex**: Disconnect and re-authorize the i118 Phone Assistant plugin. If you changed a local plugin checkout, reinstall it and begin a new chat before testing.

---

## 🛠️ The 5 MCP Tools Included

| Tool | Purpose | Description |
| :--- | :--- | :--- |
| **`whoami`** | Identity Check | Verifies your logged-in user name and email. |
| **`get_suborganizations`** | Organization Discovery | Lists all store locations and organizations you own, each with a link into the app. |
| **`get_suborganization`** | Organization Lookup | Reads an organization's record when needed to scope orders. It does not expose settings or a time zone. |
| **`get_orders`** | Order Retrieval | Retrieves complete phone orders — customer details, item modifiers, prices, delivery addresses, appointment times — with date filtering, substring search, and server-side continuation cursors. Requires an explicit `sort` (`newest` or `oldest`). Returns up to 25 orders at a time by default. Order totals are opt-in, so ask for a count when you want one. |
| **`get_order`** | Single Order Lookup | Fetches one order by its identifier. Returns exactly what `get_orders` already returns for that order, so it is only needed when an order is referenced without having been listed first. |

Every order and organization comes back with a link into [app.i118.ai](https://app.i118.ai), so the assistant can hand
you the record to open. The links carry no credentials — opening one still requires being signed in to the app.
Order timestamps are returned in UTC and automatically translated to the chat user's local/device time zone. Every
display includes the local date, local time, and labeled time zone. Ambiguous date filters use that same zone without
asking the user. Appointment times use the appointment customer's `customerTimezone` when present.

> [!TIP]
> An order's link is also where you can **play back the call recording** for that order. The recording is never
> exposed through the tools themselves, so if you want to hear exactly what the customer said, open the order.

> [!NOTE]
> An order's `#` number is a **daily** number: it restarts at #1 at the store's configured 3:00 AM business-day
> boundary. When you ask for "order #7", say which day you mean if it is ambiguous; the assistant uses your local time
> zone automatically.

---

## 🧠 Smart State & Batch Management

The `i118-order-routine` skill bundles a `scripts/state_engine.js` helper that can run in Claude Code, Codex, or ChatGPT:

* **Local Claude Code and Codex**: tracks per-organization high-water marks, token-owned renewable claims, deduplication windows, and locks. The default `orders` routine remains in `~/.i118/plugin/`.
* **Hosted ChatGPT**: can run the helper during an active workflow, but its execution storage is not a substitute for durable state across chats or devices. Use it for the current read-only order-review run; do not promise that a later ChatGPT conversation will resume its cursor or lock.

Use `I118_STATE_NAMESPACE` to choose which processes share progress. Workers doing the same task use the same stable
namespace; unrelated tasks use different namespaces and receive separate cursors, claims, locks, backups, and ledgers:

```bash
# Standard order-review routine; backward-compatible state at ~/.i118/plugin/.
I118_STATE_NAMESPACE=orders node "${CLAUDE_PLUGIN_ROOT}/skills/i118-order-routine/scripts/state_engine.js" get-filter <subOrganizationId>

# A separate workflow reading the same orders without sharing progress.
I118_STATE_NAMESPACE=pos-entry node "${CLAUDE_PLUGIN_ROOT}/skills/i118-order-routine/scripts/state_engine.js" get-filter <subOrganizationId>
```

An active claim returns a private claim token. The worker must retain it for `renew`, `commit`, or `release`; a second
worker cannot reclaim the same order merely by using the same worker name. Namespaces coordinate only processes on the
same filesystem. Multiple machines require backend transactional leases and idempotent completion receipts.

Local state directories use owner-only permissions (`0700`) and their files use `0600`.

The published i118 Phone Assistant MCP tools are read-only. The plugin must not create, cancel, send, or modify orders.

---

## 🔍 Diagnostics & Troubleshooting

If tools are not appearing or you receive an authorization error:

1. **Check MCP Access**:
   Make sure MCP access is enabled for your i118 Phone Assistant account at:
   👉 **[https://app.i118.ai/app/mcp](https://app.i118.ai/app/mcp)**
2. **Refresh the connection in your client**:
   * **Claude Code**: run `claude mcp login i118`.
   * **ChatGPT**: disconnect i118 Phone Assistant in the Apps or Connected Apps settings, reinstall/reconnect it from the app directory, and complete OAuth again.
   * **Codex**: re-authorize the plugin. For local development, reinstall after source changes and test in a new chat.
3. **Run the three diagnostic prompts**:
   * *"Check my i118 Phone Assistant connection."* — validates authentication (`whoami`).
   * *"Show my available organizations."* — validates account access (`get_suborganizations`).
   * *"Show the newest order for [organization name]."* — validates a real data query (`get_orders`).

If a step fails, share the tool name, error message, and the client you are using with i118 support. Never share OAuth tokens, authorization codes, or screenshots containing them.

For the repository test commands, live Claude Code/Codex capability matrix, and the verified Codex registered-client
OAuth development procedure, see [TESTING.md](TESTING.md).

---

## 📄 Legal & Links

- **i118 Phone Assistant Portal**: [https://app.i118.ai](https://app.i118.ai)
- **MCP Feature Activation**: [https://app.i118.ai/app/mcp](https://app.i118.ai/app/mcp)
- **Documentation**: [https://docs.i118.ai](https://docs.i118.ai)
- **Privacy Policy**: [https://docs.i118.ai/en/privacy-policy](https://docs.i118.ai/en/privacy-policy)
- **Terms of Service**: [https://docs.i118.ai/en/terms-of-service](https://docs.i118.ai/en/terms-of-service)
- **License**: Apache-2.0 Open Source
