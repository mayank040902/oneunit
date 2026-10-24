export interface AuthErrorOptions {
  code?: string;
  status?: number;
  cause?: unknown;
}

export interface JwtSignOptions {
  expiresIn?: string | number;
  expiresInSeconds?: number;
  subject?: string | number;
  audience?: string | string[];
  issuer?: string;
  jwtid?: string;
  notBefore?: string | number;
  header?: Record<string, unknown>;
  algorithm?: string;
  keyid?: string;
}

export interface JwtVerifyOptions {
  algorithms?: string[];
  audience?: string | string[];
  issuer?: string;
  subject?: string;
  clockTolerance?: number;
  ignoreExpiration?: boolean;
  complete?: boolean;
  /**
   * Token `typ` to accept. Access tokens are rejected when set to "refresh" so a
   * long-lived refresh token cannot be replayed as a bearer credential.
   */
  acceptTokenType?: "access" | "refresh";
}

export type JwtPayload = Record<string, unknown> & {
  sub?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  aud?: string | string[];
  iss?: string;
  jti?: string;
  typ?: string;
  userId?: string | number;
  email?: string;
  username?: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
  /** Session version, written only when a SessionStore is configured. */
  sv?: number;
  /** Session identifier, written only when a SessionStore is configured. */
  sid?: string;
};

export type Secret = string | Buffer;

export interface RoleDefinition {
  name?: string;
  description?: string;
  permissions?: string | string[];
  perms?: string | string[];
  inherits?: string | string[];
  parents?: string | string[];
  parent?: string | string[];
}

export interface StoredRole {
  name: string;
  description: string;
}

export interface RBACOptions {
  defaultRole?: string | null;
  permissions?: string[];
  roles?: Record<string, RoleDefinition> | Array<string | RoleDefinition>;
}

export interface AuthSubject {
  id?: string | number;
  role?: string;
  roles?: string | string[];
  permissions?: string | string[];
  [key: string]: unknown;
}

export interface PasswordOptions {
  saltBytes?: number;
  keyLength?: number;
  cost?: number;
  blockSize?: number;
  parallelism?: number;
  salt?: string | Buffer;
}

export interface OAuthProfile {
  provider?: string;
  subject?: string | number;
  id?: string | number;
  email?: string;
  emailVerified?: boolean;
  username?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatar?: string;
  profileUrl?: string;
  locale?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export interface OAuthTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

export type TokenAuthMethod = "body" | "basic";

export interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
  pkce?: boolean;
  extraAuthParams?: Record<string, unknown>;
  extraTokenParams?: Record<string, unknown>;
  userInfoHeaders?: Record<string, string>;
  tokenAuthMethod?: TokenAuthMethod;
  provider?: OAuthProvider | (Pick<OAuthProvider, "id"> & Partial<OAuthProvider>);
  /**
   * Where to fetch id_token signing keys. Defaults to Apple's published JWKS
   * endpoint. Only used by providers that carry an id_token in the token
   * response.
   */
  jwksUrl?: string;
  /**
   * Supply signing keys directly instead of fetching them. Useful for tests, for
   * offline environments, and for applications that already maintain their own
   * JWKS cache. Accepts a JWK set or a function returning one.
   */
  jwks?: Record<string, unknown> | (() => Promise<Record<string, unknown>> | Record<string, unknown>);
  /**
   * How long fetched keys are reused before being refreshed, in milliseconds.
   * Defaults to one hour. Apple rotates its keys infrequently, and an unknown
   * `kid` always triggers one immediate refetch regardless of this.
   */
  jwksCacheTtlMs?: number;
  /**
   * Set to false to skip id_token signature verification. Verification is on by
   * default and should stay on: an id_token is a bearer assertion of identity,
   * and accepting one without checking Apple's signature means anyone who can
   * influence the token response can choose the user. Only turn this off in a
   * test harness, never in production.
   */
  verifyIdTokenSignature?: boolean;
  [key: string]: unknown;
}

export interface AuthorizationUrlOptions {
  state?: string;
  redirectUri?: string;
  codeVerifier?: string;
  extraParams?: Record<string, unknown>;
}

export interface AuthorizationUrlResult {
  url: string;
  state?: string;
  codeVerifier?: string;
}

export interface ExchangeCodeOptions {
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes: string[];
  pkce: boolean;
  tokenAuthMethod: string;
  createAuthorizationUrl(config: OAuthProviderConfig, options?: AuthorizationUrlOptions): AuthorizationUrlResult;
  exchangeCode(config: OAuthProviderConfig, options?: ExchangeCodeOptions): Promise<OAuthTokens>;
  fetchProfile(config: OAuthProviderConfig, tokens: OAuthTokens): Promise<OAuthProfile>;
}

export type ProfileMapValue = string | ((source: Record<string, unknown>) => unknown);

export interface ProviderDefinition {
  id: string;
  name?: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes?: string[];
  profileMap?: Record<string, ProfileMapValue>;
  tokenAuthMethod?: TokenAuthMethod;
  pkce?: boolean;
  extraAuthParams?: Record<string, unknown>;
  extraTokenParams?: Record<string, unknown>;
  userInfoHeaders?: Record<string, string>;
  parseProfile?: (tokens: OAuthTokens, config: OAuthProviderConfig) => OAuthProfile | Promise<OAuthProfile>;
}

export interface StateStore {
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> | void;
  get(key: string): Promise<unknown> | unknown;
  delete(key: string): Promise<void> | void;
  /** Atomically look up and remove a value. Preferred over get()+delete(). */
  consume?(key: string): Promise<unknown> | unknown;
}

export interface OAuthOptions {
  redirectUri?: string;
  stateStore?: StateStore;
  providers?: Record<string, OAuthProviderConfig>;
}

export interface OAuthAuthorizeOptions {
  state?: string;
  redirectUri?: string;
  codeVerifier?: string;
  extraParams?: Record<string, unknown>;
  metadata?: unknown;
  ttlSeconds?: number;
}

export interface OAuthStateRecord {
  provider: string;
  redirectUri?: string;
  codeVerifier?: string;
  createdAt: number;
  metadata?: unknown;
}

export interface UserRecord {
  id: string | number;
  email?: string;
  username?: string;
  name?: string;
  avatar?: string;
  roles?: string[];
  role?: string;
  permissions?: string[];
  passwordHash?: string;
  provider?: string;
  providerId?: string | number;
  [key: string]: unknown;
}

export interface UserStore {
  findById?(id: string | number): Promise<UserRecord | null | undefined> | UserRecord | null | undefined;
  findByEmail?(email: string): Promise<UserRecord | null | undefined> | UserRecord | null | undefined;
  findByUsername?(username: string): Promise<UserRecord | null | undefined> | UserRecord | null | undefined;
  findByCredentials?(identifier: string): Promise<UserRecord | null | undefined> | UserRecord | null | undefined;
  findByProvider?(
    provider: string,
    providerId: string | number,
  ): Promise<UserRecord | null | undefined> | UserRecord | null | undefined;
  create?(input: Record<string, unknown>): Promise<UserRecord> | UserRecord;
  createFromProvider?(
    provider: string,
    profile: OAuthProfile,
    tokens: OAuthTokens,
  ): Promise<UserRecord> | UserRecord;
  linkProvider?(userId: string | number, provider: string, profile: OAuthProfile): Promise<unknown> | unknown;
  updatePassword?(userId: string | number, passwordHash: string): Promise<unknown> | unknown;
}

export interface RefreshRecord {
  id: string;
  userId: string | number;
  tokenHash: string;
  expiresAt: number;
}

export interface RefreshStore {
  save(record: RefreshRecord): Promise<void> | void;
  get(id: string): Promise<RefreshRecord | null | undefined> | RefreshRecord | null | undefined;
  /**
   * Atomically look up and remove a record. Preferred over get()+revoke(), which
   * lets one refresh token be redeemed twice concurrently. When omitted, Auth
   * falls back to get() followed by revoke() and requires revoke() to exist.
   */
  consume?(id: string): Promise<RefreshRecord | null | undefined> | RefreshRecord | null | undefined;
  revoke?(id: string): Promise<void> | void;
}

export interface LoginOptions {
  extractors?: string[];
  additionalClaims?: Record<string, unknown>;
  accessTokenTtl?: string | number;
  refreshTokenTtl?: string | number;
  refresh?: boolean;
  roles?: string[];
}

export interface LoginResult {
  token: string;
  accessToken: string;
  refreshToken: string | null;
  payload: JwtPayload;
  user: {
    id: string | number;
    email?: string;
    username?: string;
    name?: string;
    roles: string[];
    permissions: string[];
  };
  oauth?: {
    provider: string;
    tokens: OAuthTokens;
    profile: OAuthProfile;
    state: unknown;
  };
}

export interface SessionStore {
  /**
   * The user's current session version. Tokens are minted carrying the value
   * that was current at login, and are rejected once it no longer matches, so
   * bumping the number logs out every session issued before that moment.
   * Returning `undefined` or `null` is treated as version 0.
   */
  getVersion(userId: string | number): Promise<number | undefined | null> | number | undefined | null;
  /**
   * Invalidate every session currently issued to this user and return the new
   * version. Called by `revokeAllSessions`.
   */
  bumpVersion?(userId: string | number): Promise<number> | number;
  /**
   * Invalidate one session by its session id. Called by `revokeSession`.
   */
  revokeSession?(jti: string): Promise<void> | void;
  /**
   * Whether a session (identified by its `sid` claim) has been revoked.
   * Implement this (or expose an equivalent revoked-session set/map/array) so
   * the library can reject access tokens whose session was revoked before
   * expiry. When it is unavailable, revocation can only be enforced within the
   * process that recorded it.
   */
  isSessionRevoked?(sessionId: string): Promise<boolean> | boolean;
}

export interface AuthOptions {
  secret: Secret;
  refreshSecret?: Secret;
  issuer?: string;
  audience?: string | string[];
  algorithm?: string;
  expiresIn?: string | number;
  accessTokenTtl?: string | number;
  refreshTokenTtl?: string | number;
  clockTolerance?: number;
  /**
   * Copy a `permissions` array from the user record into the access token.
   * Off by default: permissions should come from RBAC roles, otherwise one
   * attacker-writable database field grants arbitrary access.
   */
  trustUserPermissions?: boolean;
  userStore?: UserStore;
  refreshStore?: RefreshStore;
  /**
   * Enables session revocation. Configuring one adds an `sv` claim to minted
   * tokens and costs one store read per verification, which is why it is
   * opt-in: without it, revoking a refresh token only invalidates that one
   * session, and an already-issued access token stays valid until it expires.
   */
  sessionStore?: SessionStore;
  rbac?: import("../rbac/index.js").RBAC | RBACOptions;
  roles?: RBACOptions | Record<string, RoleDefinition> | Array<string | RoleDefinition>;
  oauth?: import("../oauth/index.js").OAuth | OAuthOptions;
  providers?: Record<string, OAuthProviderConfig>;
  redirectUri?: string;
  onLogin?: (result: LoginResult) => unknown;
  onLink?: (event: { user: UserRecord; provider: string; profile: OAuthProfile }) => unknown;
}

export type AuthHookName = "beforeLogin" | "afterLogin" | "afterVerify";
export type AuthHookHandler = (payload: unknown, auth: unknown) => unknown;

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined> | { get?(name: string): string | null };
  cookies?: Record<string, string>;
  query?: string | Record<string, string | string[] | undefined>;
  getHeader?(name: string): string;
  getQuery?(): string;
  forEach?(cb: (key: string, value: string) => void): void;
  [key: string]: unknown;
}

export interface ExtractTokenOptions {
  cookie?: string;
  /**
   * Allow reading the token from `?access_token=` or `?token=`. Off by default:
   * a token in a URL is written to access logs, proxy logs, browser history, and
   * the Referer header sent to third parties, none of which a header or cookie
   * token leaks into. Only enable it for flows that genuinely cannot set a
   * header, such as an EventSource or a file download.
   */
  query?: boolean;
  optional?: boolean;
  passthrough?: boolean;
  audience?: string | string[];
  issuer?: string;
  clockTolerance?: number;
  acceptTokenType?: "access" | "refresh";
}

export interface UwsHttpResponse {
  cork?(cb: () => void): void;
  writeStatus?(status: string): this | void;
  writeHeader?(key: string, value: string): this | void;
  end?(body?: string | ArrayBuffer | Uint8Array): void;
  onAborted?(cb: () => void): void;
  [key: string]: unknown;
}

export interface UwsHttpRequest {
  getHeader?(name: string): string;
  getMethod?(): string;
  getUrl?(): string;
  getQuery?(): string;
  forEach?(cb: (key: string, value: string) => void): void;
  [key: string]: unknown;
}

export interface UwsRequestSnapshot {
  method?: string;
  url?: string;
  query?: string | Record<string, string>;
  headers: Record<string, string>;
  cookies?: Record<string, string>;
  res?: UwsHttpResponse;
  user?: JwtPayload | null;
  token?: string | null;
}

export type UwsHandler = (
  res: UwsHttpResponse,
  req: UwsHttpRequest,
  request?: UwsRequestSnapshot,
) => unknown;

export interface ExpressRequestLike {
  auth?: unknown;
  user?: JwtPayload | null;
  token?: string | null;
  headers?: Record<string, string | undefined>;
  cookies?: Record<string, string>;
  query?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface ExpressResponseLike {
  status?(code: number): ExpressResponseLike;
  send?(body: unknown): unknown;
  code?(code: number): ExpressResponseLike;
  body?: unknown;
  [key: string]: unknown;
}

export type ExpressNext = (error?: unknown) => void;

export type ExpressHandler = (
  req: ExpressRequestLike,
  res: ExpressResponseLike,
  next?: ExpressNext,
) => unknown;

export interface KoaContextLike {
  request?: RequestLike;
  state: { user?: JwtPayload | null; token?: string | null; [key: string]: unknown };
  status: number;
  body: unknown;
}

export interface FastifyLike {
  decorate(name: string, value: unknown): void;
  decorateRequest(name: string, value: unknown): void;
  [key: string]: unknown;
}

export interface FastifyRequestLike {
  user?: JwtPayload | null;
  headers?: Record<string, string | undefined>;
  cookies?: Record<string, string>;
  query?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface FastifyReplyLike {
  code(status: number): FastifyReplyLike;
  send(body: unknown): unknown;
}
