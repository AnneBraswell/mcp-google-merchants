/**
 * Paintarthub Cloudflare remote MCP adapter.
 * The upstream A1-x-Tech STDIO implementation remains available via src/index.ts.
 * No GMC data is changed during deployment; product writes are OFF by default.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
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
        const isProductWrite = /^(products\/v1\/accounts\/[^/]+\/productInputs)(\/|$)/.test(cleanPath) &&
          ["POST", "PATCH", "DELETE"].includes(method);
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
