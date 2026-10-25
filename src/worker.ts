/**
 * Paintarthub Cloudflare remote MCP adapter.
 * The upstream A1-x-Tech STDIO implementation remains available via src/index.ts.
 * No GMC data is changed during deployment; product writes are OFF by default.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { HttpMethod, Query, AccessTokenProvider } from "./client.js";
import { MerchantsClient } from "./client.js";
import { DEFAULT_BASE, DEFAULT_TOKEN_URL } from "./config.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerProductTools } from "./tools/products.js";
import { registerDataSourceTools } from "./tools/datasources.js";
import { registerReportTools } from "./tools/reports.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerQuotaTools } from "./tools/quota.js";
import { GoogleHandler, type MerchantOAuthProps } from "./worker-auth.js";

export class MerchantMCP extends McpAgent<Env, Record<string, never>, MerchantOAuthProps> {
  server = new McpServer({ name: "Paintarthub GMC MCP", version: "1.0.0" });

  private tokenCache?: { value: string; expiresAt: number };

  private tokenProvider(): AccessTokenProvider {
    return {
      canRefresh: () => Boolean(this.props.refreshToken),
      getAccessToken: async (forceRefresh = false) => {
        const now = Date.now();
        if (!forceRefresh && this.tokenCache && this.tokenCache.expiresAt > now) {
          return this.tokenCache.value;
        }
        if (!forceRefresh && this.props.accessToken && this.props.tokenExpiresAt > now) {
          this.tokenCache = { value: this.props.accessToken, expiresAt: this.props.tokenExpiresAt };
          return this.props.accessToken;
        }
        if (!this.props.refreshToken) {
          throw new Error("Google OAuth token expired. Disconnect and reconnect the GMC MCP.");
        }
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.env.GOOGLE_CLIENT_ID,
            client_secret: this.env.GOOGLE_CLIENT_SECRET,
            refresh_token: this.props.refreshToken,
            grant_type: "refresh_token",
          }),
        });
        if (!response.ok) {
          throw new Error("Google token refresh failed. Reconnect the GMC MCP in ChatGPT.");
        }
        const data = await response.json() as { access_token?: string; expires_in?: number };
        if (!data.access_token) throw new Error("Google token response was missing an access token.");
        this.tokenCache = {
          value: data.access_token,
          expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
        };
        return data.access_token;
      },
    };
  }

  async init() {
    const client = new MerchantsClient({
      apiBase: DEFAULT_BASE,
      tokenUrl: DEFAULT_TOKEN_URL,
      accountId: this.env.GOOGLE_MERCHANTS_ACCOUNT_ID || undefined,
      maxRetries: 3,
    }, this.tokenProvider());

    // Defense in depth: the original project also exposes destructive operations.
    // Only product-input writes can ever be enabled; all other mutations are blocked.
    // This is a server-side guard, not just an instruction to the language model.
    const request = client.request.bind(client);
    client.request = (<T = unknown>(
      method: HttpMethod, path: string, body?: Record<string, unknown>, query?: Query,
    ): Promise<T> => {
      const cleanPath = path.replace(/^\/+/, "");
      const isReportRead = method === "POST" &&
        /^reports\/v1\/accounts\/[^/]+\/reports:search$/.test(cleanPath);
      if (method !== "GET" && !isReportRead) {
        const isProductWrite = (
          method === "POST" && /^products\/v1\/accounts\/[^/]+\/productInputs:insert$/.test(cleanPath)
        ) || (
          (method === "PATCH" || method === "DELETE") &&
          /^products\/v1\/accounts\/[^/]+\/productInputs\/[^/]+$/.test(cleanPath)
        );
        if (!isProductWrite || this.env.GMC_WRITES_ENABLED !== "true") {
          throw new Error(
            "GMC write blocked by server policy. Only product-input writes are permitted " +
            "after GMC_WRITES_ENABLED=true is explicitly configured in Cloudflare.",
          );
        }
      }
      return request<T>(method, path, body, query);
    }) as typeof client.request;

    // Reuse A1-x-Tech's real Merchant API v1 tool implementation.
    // Do not expose raw_request, arbitrary account modifications or promotions writes.
    registerAccountTools(this.server, client);
    registerProductTools(this.server, client);
    registerDataSourceTools(this.server, client);
    registerReportTools(this.server, client);
    registerIssueTools(this.server, client);
    registerQuotaTools(this.server, client);

    // One-time Merchant API developer registration, deliberately scoped to Paintarthub.
    // This operation adds API_DEVELOPER to the signed-in Merchant Center administrator.
    // Google links the project identified by this OAuth access token automatically.
    this.server.registerTool("gmc_register_developer", {
      title: "Register Paintarthub's Google Cloud project for Merchant API",
      description:
        "One-time explicit ADMIN-only registration for Paintarthub Merchant Center account 5348631431. " +
        "Links the OAuth client Google Cloud project and adds API_DEVELOPER to the signed-in email. " +
        "Only invoke when the owner expressly requests developer registration. " +
        "Never edits or deletes GMC products.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        confirmation: z.literal("REGISTER_PAINTARTHUB_GMC").describe(
          "Explicit registration approval phrase; mandatory for this account-level change.",
        ),
      },
    }, async ({ confirmation }) => {
      if (confirmation !== "REGISTER_PAINTARTHUB_GMC") {
        return { isError: true, content: [{ type: "text", text: "Explicit confirmation is required." }] };
      }
      const signedInEmail = (this.props.email || "").trim().toLowerCase();
      const allowed = (this.env.ALLOWED_EMAILS || "").split(",").map(x => x.trim().toLowerCase());
      if (!signedInEmail || !allowed.includes(signedInEmail)) {
        return { isError: true, content: [{ type: "text", text: "OAuth email is not in the authorized allowlist." }] };
      }
      const token = await this.tokenProvider().getAccessToken();
      const endpoint =
        "https://merchantapi.googleapis.com/accounts/v1/accounts/5348631431/developerRegistration:registerGcp";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ developerEmail: signedInEmail }),
      });
      const payload = await response.text();
      if (!response.ok) {
        return { isError: true, content: [{ type: "text", text: "Registration failed, HTTP " + response.status + ": " + payload }] };
      }
      return { content: [{ type: "text", text: "Developer registration succeeded for Merchant Center 5348631431; Google response: " + payload }] };
    });

    this.server.registerTool("gmc_get_developer_registration", {
      title: "Check Paintarthub Merchant API developer registration",
      description: "Read-only check of the Google Cloud project registration with Merchant Center 5348631431.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {},
    }, async () => {
      const token = await this.tokenProvider().getAccessToken();
      const response = await fetch(
        "https://merchantapi.googleapis.com/accounts/v1/accounts/5348631431/developerRegistration",
        { headers: { Authorization: "Bearer " + token } },
      );
      const payload = await response.text();
      return { isError: !response.ok, content: [{ type: "text", text: "HTTP " + response.status + ": " + payload }] };
    });

    this.server.registerTool("gmc_connection_status", {
      title: "Check GMC MCP write safety",
      description: "Returns server-side write settings; does not contact Google or expose secrets.",
      inputSchema: {},
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify({
        connectedGoogleEmail: this.props.email,
        productWritesEnabled: this.env.GMC_WRITES_ENABLED === "true",
        nonProductWritesEnabled: false,
        server: "paintarthub-gmc",
      }) }],
    }));
  }
}

export default new OAuthProvider({
  apiHandler: MerchantMCP.mount("/sse") as any,
  apiRoute: "/sse",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GoogleHandler as any,
  tokenEndpoint: "/token",
  accessTokenTTL: 60 * 60 * 24 * 30,
});
