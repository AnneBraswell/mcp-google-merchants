# Paintarthub GMC — Cloudflare remote MCP

This fork includes an isolated remote MCP adapter built on A1-x-Tech's Merchant API v1 tools. The upstream STDIO entrypoint remains at `src/index.ts`; the Cloudflare entrypoint is `src/worker.ts`.

## Behavior and safety
- Google OAuth 2.0, limited to verified emails in `ALLOWED_EMAILS`.
- OAuth state stored for 10 minutes in a dedicated Workers KV namespace.
- Merchant API scope is `https://www.googleapis.com/auth/content` (Google does **not** provide a narrower read-only scope).
- **Product writes are off by default** (`GMC_WRITES_ENABLED=false`).
- Only Merchant API product-input POST/PATCH/DELETE can be enabled with the explicit variable `GMC_WRITES_ENABLED=true`. All other mutation paths remain blocked.
- **Important**: `raw_request`, promotions writes and data-source writes are *not* exposed. No GMC product changes are made by this deployment.
- Avoid directly editing Shopify-managed product inputs before checking the authoritative feed: a future Shopify sync may replace or re-create the product.
- Google Cloud must have Merchant API enabled, and the project must be registered with Merchant Center (developer registration). This registration requires an appropriately privileged GMC administrator.

## 1. Google Cloud
Use your existing Google Cloud project that has Merchant API enabled. Create a **new Web application OAuth client** for this GMC Worker (preferred for isolating consent, redirects and secret rotation).
- Authorized JavaScript origin: `https://paintarthub-gmc.863476792g.workers.dev`
- Authorized redirect URI: `https://paintarthub-gmc.863476792g.workers.dev/callback`
- While OAuth consent is in Testing mode, include the authorized Google login email under Test users.
- For Google OAuth `content` scope you may have to pass Google's unverified-app screen for your private test user.
- Do **not** commit OAuth credentials to GitHub.

## 2. Cloudflare
Create a **separate Worker** named `paintarthub-gmc`, connected to this GitHub repository `AnneBraswell/mcp-google-merchants`, branch `main`.
- Build command: `npm install --legacy-peer-deps`
- Deploy command: `npx wrangler deploy`
- Wrangler config: `wrangler.jsonc` (includes existing private KV binding).
- Confirm successful GitHub Action validation before deploying if possible.
- In Worker Settings -> Variables and Secrets, create all four as **Secret**:
  - `GOOGLE_CLIENT_ID`: the new GMC Google OAuth Web client ID.
  - `GOOGLE_CLIENT_SECRET`: the new GMC Google OAuth Web client secret.
  - `COOKIE_ENCRYPTION_KEY`: a **randomly generated** 64-character hex string (32 bytes).
  - `ALLOWED_EMAILS`: comma-separated Google email addresses authorized to sign in.
- Optional nonsecret: `GOOGLE_MERCHANTS_ACCOUNT_ID` (Merchant Center ID). Can omit and pass the account to each tool.
- Keep `GMC_WRITES_ENABLED` set to `false` during initial validation.
- Never paste credentials into chat.

## 3. ChatGPT connection
Create a custom MCP with URL `https://paintarthub-gmc.863476792g.workers.dev/sse`. Authenticate using the allowlisted Google account. Test `gmc_connection_status`, `list_accounts`, `list_data_sources`, and `get_product` before attempting to enable writes.

## 4. Developer registration
Google Merchant API may return `PERMISSION_DENIED` before one-time developer registration. In that case, use a Merchant Center administrator to register your existing Google Cloud project following https://developers.google.com/merchant/api/guides/quickstart . This fork intentionally omits a generic raw write endpoint, so registration must be completed outside this MCP.

## 5. Enabling writes after successful read-only testing
Only after checking target product, authoritative data source, and Shopify behavior, set `GMC_WRITES_ENABLED=true`. The product-input write tools remain annotated as write/destructive and should always require explicit human confirmation. The variable can be changed back to `false` to block writes.
