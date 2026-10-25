interface Env {
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ALLOWED_EMAILS: string;
  GOOGLE_MERCHANTS_ACCOUNT_ID?: string;
  GMC_WRITES_ENABLED?: string;
  MCP_OBJECT: DurableObjectNamespace;
}
