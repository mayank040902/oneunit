import {
  createAuth,
  createRBAC,
  hashPassword,
  verifyPassword,
  needsRehash,
  encode,
  decode,
  decodeUnsafe,
  encodeAccessToken,
  encodeRefreshToken,
  isValidExpiresIn,
  parseExpiresIn,
  randomToken,
  randomState,
  createOAuth,
  createProvider,
  createMemoryRefreshStore,
  createMemoryStateStore,
  matchPermission,
  extractBearerToken,
  pkceVerifier,
  pkceChallenge,
  createMemoryStateStore as createStateStore,
} from "../src/index.js";

const secret = "example-secret-".repeat(4);

// JWT helpers.
const token = encode({ userId: 123, role: "admin" }, secret, { expiresIn: "1h", subject: "123" });
const claims = decode(token, secret);
console.log("decoded token:", claims.userId);
console.log("unsafe decode:", (decodeUnsafe(token) as { userId?: unknown }).userId);
const accessToken = encodeAccessToken({ sub: "1" }, secret, { expiresIn: "10m" });
const refreshToken = encodeRefreshToken({ sub: "1" }, secret, {
  jwtid: randomToken(16),
  expiresIn: "1d",
});
console.log("access/refresh token formats issued");

// RBAC.
const rbac = createRBAC({
  defaultRole: "member",
  roles: {
    member: { permissions: ["profile.read"] },
    editor: { inherits: "member", permissions: ["post.write"] },
  },
});
const subject = { roles: ["editor"], permissions: ["beta.access"] };
console.log("can post.write:", rbac.can(subject, "post.write"));
console.log("matchPermission:", matchPermission("invoice.**", "invoice.read.all"));

// Auth core.
const auth = createAuth({
  secret,
  rbac,
  trustUserPermissions: true,
  accessTokenTtl: "15m",
  refreshTokenTtl: "7d",
  refreshStore: createMemoryRefreshStore(),
});

const sessionVersions = new Map<string, number>();
const sessionStore = {
  async getVersion(userId: string | number) {
    return sessionVersions.get(String(userId)) ?? 0;
  },
  async bumpVersion(userId: string | number) {
    const next = (sessionVersions.get(String(userId)) ?? 0) + 1;
    sessionVersions.set(String(userId), next);
    return next;
  },
};
const authWithSessions = createAuth({
  secret,
  rbac,
  sessionStore,
});

auth.registerExtractor("tenantId", (user) => `tenant-${user.id}`);
const session = await auth.login(
  { id: 2, email: "ada@example.com", roles: ["editor"] },
  { additionalClaims: { tenantId: "acme" } },
);
console.log("login subject:", session.payload.sub);

try {
  auth.registerExtractor("sub", () => "attacker");
} catch {
  console.log("reserved extractor rejected");
}

const verified = await auth.verify(session.accessToken);
console.log("verified tenantId:", (verified as { tenantId?: unknown }).tenantId);

// Password registration and login with an in-memory user store.
const users = new Map();
const userStore = {
  async create(input: Record<string, unknown>) {
    const user = { id: users.size + 1, ...input };
    users.set(user.id, user);
    return user;
  },
  async findByCredentials(identifier: string) {
    return [...users.values()].find((user: any) =>
      user.email === identifier || user.username === identifier,
    );
  },
  async findByEmail(email: string) {
    return [...users.values()].find((user: any) => user.email === email);
  },
  async updatePassword(id: number, passwordHash: string) {
    const user = users.get(id);
    if (user) user.passwordHash = passwordHash;
  },
};
const authWithPasswords = createAuth({
  secret,
  rbac,
  userStore: userStore as any,
});
await authWithPasswords.register(
  { email: "bob@example.com", password: "super-secret" },
  { roles: ["member"] },
);
const passwordSession = await authWithPasswords.loginWithPassword("bob@example.com", "super-secret");
console.log("password login:", passwordSession.payload.sub);

const passwordHash = await hashPassword("correct horse battery staple");
console.log("password verifies:", await verifyPassword("correct horse battery staple", passwordHash));
console.log("needsRehash:", needsRehash(passwordHash, { cost: 16384 }));

// Refresh rotation and replay protection.
const refreshed = await auth.refresh(session.refreshToken!);
console.log("refresh rotated:", refreshed.refreshToken !== session.refreshToken);

let replayRejected = false;
try {
  await auth.refresh(session.refreshToken!);
} catch {
  replayRejected = true;
}
console.log("replayed refresh rejected:", replayRejected);

// Session revocation.
const protectedSession = await authWithSessions.login({ id: 3, roles: ["member"] });
await authWithSessions.revokeAllSessions(3);
let revokedRejected = false;
try {
  await authWithSessions.verify(protectedSession.accessToken);
} catch {
  revokedRejected = true;
}
console.log("revoked session rejected:", revokedRejected);

// Utilities and TTL validation.
console.log("isValidExpiresIn:", isValidExpiresIn("15m"));
console.log("parseExpiresIn 7d:", parseExpiresIn("7d"));
console.log("randomToken length:", randomToken(8).length);
console.log("randomState non-empty:", randomState().length > 0);
console.log("extractBearerToken:", extractBearerToken("Bearer token123") === "token123");

// OAuth and PKCE.
const oauthProvider = createProvider({
  id: "acme",
  authorizationUrl: "https://acme.example/oauth/authorize",
  tokenUrl: "https://acme.example/oauth/token",
  profileMap: { id: "id", email: "email", name: "name" },
});

const oauth = createOAuth({ stateStore: createStateStore() });
oauth.use("acme", { provider: oauthProvider, clientId: "client-id", pkce: true });
const { url, codeVerifier } = await oauth.authorize("acme");
console.log("OAuth URL contains challenge:", url.includes("code_challenge"));
console.log("PKCE verifier/challenge valid:", pkceChallenge(pkceVerifier()).length > 0);

console.log("example complete");
