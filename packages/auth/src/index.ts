export {
  AuthError,
  InvalidTokenError,
  TokenExpiredError,
  UnauthorizedError,
  ForbiddenError,
  ConfigurationError,
  OAuthError,
  ProviderError,
  ValidationError,
} from "./errors/index.js";

export {
  encode,
  decode,
  decodeUnsafe,
  encodeAccessToken,
  encodeRefreshToken,
} from "./crypto/index.js";

export {
  RBAC,
  createRBAC,
  defineRoles,
  matchPermission,
} from "./rbac/index.js";

export {
  hashPassword,
  verifyPassword,
  needsRehash,
} from "./crypto/index.js";

export {
  OAuth,
  createOAuth,
  createMemoryStateStore,
} from "./oauth/index.js";

export {
  createProvider,
  getProvider,
  builtinProviders,
  pkceVerifier,
  pkceChallenge,
  google,
  github,
  instagram,
  facebook,
  twitter,
  discord,
  apple,
  linkedin,
  microsoft,
  reddit,
  twitch,
  slack,
  spotify,
  tiktok,
} from "./oauth/providers/index.js";

export {
  Auth,
  auth,
  createAuth,
  createMemoryRefreshStore,
  createMemorySessionStore,
} from "./core/index.js";

export {
  expressAdapter,
  fastifyAdapter,
  koaAdapter,
  uwsAdapter,
  snapshotUwsRequest,
  createAdapters,
} from "./adapters/index.js";

export {
  parseExpiresIn,
  isValidExpiresIn,
  randomToken,
  randomState,
  extractBearerToken,
} from "./utils.js";

export type {
  AuthErrorOptions,
  JwtSignOptions,
  JwtVerifyOptions,
  JwtPayload,
  Secret,
  RoleDefinition,
  RBACOptions,
  AuthSubject,
  PasswordOptions,
  OAuthProfile,
  OAuthTokens,
  OAuthProviderConfig,
  OAuthProvider,
  ProviderDefinition,
  StateStore,
  SessionStore,
  OAuthOptions,
  OAuthAuthorizeOptions,
  UserRecord,
  UserStore,
  RefreshRecord,
  RefreshStore,
  LoginOptions,
  LoginResult,
  AuthOptions,
  RequestLike,
  ExtractTokenOptions,
  UwsHttpResponse,
  UwsHttpRequest,
  UwsRequestSnapshot,
  UwsHandler,
  ExpressRequestLike,
  ExpressResponseLike,
  ExpressNext,
  KoaContextLike,
  FastifyLike,
  FastifyRequestLike,
  FastifyReplyLike,
} from "./types/index.js";
