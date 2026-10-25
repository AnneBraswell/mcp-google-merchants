import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { clientIdAlreadyApproved, parseRedirectApproval, renderApprovalDialog } from "./worker-oauth-utils.js";

export type MerchantOAuthProps = {
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
};

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

function emailAllowed(email: string, env: Env): boolean {
  return (env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase())
    .filter(Boolean).includes(email.toLowerCase().trim());
}

async function googleRedirect(c: Context, oauthReqInfo: AuthRequest, headers: Record<string,string> = {}) {
  const state = crypto.randomUUID();
  await (c.env as Env).OAUTH_KV.put("gmc-oauth-state:" + state, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set("client_id", (c.env as Env).GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/callback", c.req.url).href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/content");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { ...headers, location: url.toString() } });
}

app.get("/authorize", async c => {
  const auth = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!auth.clientId) return c.text("Missing MCP client ID", 400);
  if (await clientIdAlreadyApproved(c.req.raw, auth.clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    return googleRedirect(c, auth);
  }
  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(auth.clientId),
    server: {
      name: "Paintarthub GMC MCP",
      description: "Merchant Center products, feeds, issues and reports. Google content permission allows reads and writes; product writes remain server-disabled by default.",
    },
    state: { oauthReqInfo: auth },
  });
});

app.post("/authorize", async c => {
  const { state, headers } = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY);
  if (!state?.oauthReqInfo) return c.text("Invalid OAuth approval", 400);
  return googleRedirect(c, state.oauthReqInfo as AuthRequest, headers);
});

app.get("/callback", async c => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || !code) return c.text("Google OAuth denied or missing code", 400);
  const key = "gmc-oauth-state:" + state;
  const saved = await c.env.OAUTH_KV.get(key);
  if (!saved) return c.text("Expired or invalid OAuth state. Restart connection.", 400);
  await c.env.OAUTH_KV.delete(key);
  const auth = JSON.parse(saved) as AuthRequest;
  if (!auth.clientId) return c.text("Invalid MCP client request", 400);
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: new URL("/callback", c.req.url).href,
    }),
  });
  if (!response.ok) return c.text("Google OAuth token exchange failed", 400);
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!token.access_token) return c.text("Missing Google access token", 400);
  const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: "Bearer " + token.access_token },
  });
  if (!userResponse.ok) return c.text("Google account identity check failed", 403);
  const user = await userResponse.json() as { id?: string; name?: string; email?: string; verified_email?: boolean };
  if (!user.id || !user.email || !user.verified_email || !emailAllowed(user.email, c.env)) {
    return c.text("This Google account is not authorized for Paintarthub GMC.", 403);
  }
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: user.name || user.email },
    props: {
      email: user.email,
      name: user.name || user.email,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || "",
      tokenExpiresAt: Date.now() + Math.max(0, (token.expires_in ?? 3600) - 60) * 1000,
    } as MerchantOAuthProps,
    request: auth,
    scope: auth.scope,
    userId: user.id,
  });
  return Response.redirect(redirectTo);
});

export { app as GoogleHandler };
