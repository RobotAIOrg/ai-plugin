# OpenAI Plugin Submission Worksheet

Use this worksheet when creating the i118 Phone Assistant submission in the OpenAI Platform. The public submission uses an MCP server and uploaded skills; it does not require a ChatGPT App UI.

## Portal inputs

- Submission type: **With MCP**
- URL type: **Universal**
- MCP URL: use the production endpoint when it is ready for submission.
- Publisher: select the verified i118.ai business identity.
- Listing: use the plugin name, descriptions, logo, category, website, privacy policy, and terms from `.codex-plugin/plugin.json`.
- Support URL: enter the public i118.ai support contact URL.
- Authentication: use the configured predefined public OAuth client with PKCE. This is configured in ChatGPT/Clerk, not in this plugin manifest.
- Reviewer account: provide a dedicated i118 Phone Assistant account with the `Mcp` role, sample organizations, and no MFA, SMS, email-confirmation, or private-network requirement.
- Availability: select only countries where i118.ai support and terms are available.

## Positive tests

| Prompt | Expected behavior | Expected result |
| --- | --- | --- |
| “Check my i118 Phone Assistant connection.” | Calls `whoami`, then `get_suborganizations`. | Authenticated identity and accessible organizations. |
| “Show my newest phone orders.” | Lists organizations, then asks the user which organization to use when more than one is available. | A choice of organizations; no orders are fetched until the user chooses. |
| “Show orders for Test from yesterday, oldest first.” | Calls `get_orders` for the named organization with an ISO 8601 range and `sort: oldest`. | Chronological filtered orders. |
| “Confirm Test is available before viewing its orders.” | Resolves the named organization with read-only discovery. | Confirms the chosen organization without exposing internal IDs or describing settings. |
| “For Test, retrieve the newest order, then confirm a direct lookup represents that same order.” | Uses `get_orders` and, only when an order is returned, `get_order`. | Confirms the same order record without exposing internal IDs. |

## Negative tests

| Prompt or scenario | Expected safe behavior | Why |
| --- | --- | --- |
| “Show orders for organization `<another-tenant-id>`.” | Return `Not found.` without revealing whether the organization exists. | The reviewer account does not own it. |
| Resume a `get_orders` cursor after changing `sort` or dates. | Return the cursor/filter mismatch error and request a fresh search. | A cursor is scoped to its original filters. |
| “Create, cancel, send, or modify an order.” | Explain that this plugin’s OAuth tools are read-only and do not perform the requested write. | The submitted OAuth tool surface has no write capability. |

## Release notes

Version `1.0.0` of i118 Phone Assistant provides authenticated, read-only access to the user’s organizations and phone-order records, plus reusable order-query skills. Local Claude Code and Codex routines support isolated workflow namespaces and token-owned renewable claims. In hosted ChatGPT, the optional order routine remains limited to bounded, read-only review in the active workflow; it is not a durable cross-chat queue or a write capability.

Before submitting, scan the deployed MCP server again and confirm the discovered tools and imported skill snapshot match this repository.
