# Opt-in scoped MCP access

`AGENTMEMORY_TOOLS=core` controls visibility. It is not an authorization boundary.
In proxy mode, the standalone client receives the backend catalog, so setting it
only on the client does not reduce that catalog.

For a separate MCP-only identity, configure a distinct `AGENTMEMORY_MCP_SECRET`
on the backend, in addition to the existing administrative `AGENTMEMORY_SECRET`.
Keep both values in the operator's approved secret store. An absent or empty MCP
secret disables the scoped identity. A configured MCP secret with a missing admin
secret or equal secrets makes registration fail rather than creating an ambiguous
identity.

The scoped identity can use only the tool-list and tool-call endpoints. Its
default allowlist is `memory_recall,memory_smart_search`. Set
`AGENTMEMORY_MCP_ALLOWED_TOOLS` explicitly to change it. Unknown tool names fail
registration; an explicitly empty list permits no tools. Calls to unlisted
tools return HTTP403 before SDK dispatch. The scoped credential is not accepted
by raw REST endpoints, administrative import/export, MCP resources or prompts.
The existing administrative identity and its visibility configuration remain
unchanged.

On the standalone client, set `AGENTMEMORY_URL` to the backend and set its
`AGENTMEMORY_SECRET` to the scoped MCP value. Also set
`AGENTMEMORY_MCP_ONLY=1` and `AGENTMEMORY_FORCE_PROXY=1`. MCP-only mode forwards
tool calls through `/agentmemory/mcp/call`, including essential tools that would
otherwise use raw REST endpoints. At process startup this mode creates only a
nonpersistent scratch KV, so startup, signals and fatal persistence callbacks do
not load or overwrite a local fallback store. It refuses local fallback and
invalid or unavailable remote catalogs. Do not expose the administrative secret
to that client or worker.

CLI Worker Compose forwards both new backend settings. Docker Worker Compose
forwards them with empty defaults: no configured MCP secret keeps the feature
disabled; a configured secret without an explicit allowlist yields no tools.
Set the desired allowlist explicitly for Docker. This retains fail-closed empty
allowlists rather than interpreting an empty value as the default read tools.

Acceptance must exercise the configured client: exact allowed tool inventory,
successful authorized retrieval, denied known but unlisted tool calls, denied
raw REST/export/import using the scoped credential, invalid-credential rejection,
and a preserved administrative positive control. Repeat company-isolation and
expiry tests with live synthetic records. Unit fixtures alone do not prove a
deployed credential boundary. No client, secret, or running service is configured
by adding this source change.

The allowlist controls tool dispatch, not the semantic contents of returned
records. Apply company/project scope, provenance, retention and content-review
rules independently. This is not a per-user multi-tenant authorization system or
a substitute for an approval workflow.
