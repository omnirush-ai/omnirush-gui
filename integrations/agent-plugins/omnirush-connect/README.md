# OmniRush.ai Connect Agent Plugin

This directory is the portable OmniRush.ai Connect package for the published
Agent Plugins 1.0.0 specification. Install or copy the complete directory
through an Agent Plugins-compatible client. The package installs:

- the remote OmniRush.ai MCP endpoint of your organization's Den;
- guidance for the `search_capabilities` and `execute_capability` workflow;
- no credentials or client-specific authentication configuration.

## Set your Den endpoint before installing

omnirush.ai runs no hosted Den, so this package has no working default
endpoint. `mcp.json` ships with the placeholder
`https://replace-with-your-den-api-origin.invalid/mcp/agent`. The `.invalid`
top-level domain is reserved and never resolves, so an unedited package fails
closed instead of sending anything to a host you do not control. Replace the
URL with your Den API origin followed by `/mcp/agent`, for example
`https://den.example.com/mcp/agent`, before you install or distribute the
package.

The MCP client discovers OmniRush.ai OAuth from the endpoint and opens the normal
browser sign-in flow. Access remains scoped to the selected organization and
the signed-in member's grants.

The `streamable-http` entry does not pin an MCP wire version. OmniRush.ai Connect
negotiates the stateless MCP 2026-07-28 protocol with current clients and keeps
the existing MCP 2025-11-25 compatibility path for clients that have not yet
migrated. No session identifier, token, or protocol-specific header is stored
in this package.

Agent Plugins does not standardize registries or installation UX. Distribution
of this directory is therefore client-specific.
