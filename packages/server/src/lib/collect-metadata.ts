export function collectMetadata(
  request: Record<string, unknown> & {
    headers?: Record<string, unknown>;
    user?: { id?: unknown; type?: unknown };
    id?: unknown;
    ip?: unknown;
    ips?: unknown;
    method?: unknown;
    url?: unknown;
    hostname?: unknown;
    protocol?: unknown;
    query?: unknown;
    params?: unknown;
    body?: unknown;
    routeOptions?: { url?: unknown };
    raw?: { httpVersion?: unknown };
  },
  reply: { statusCode?: unknown } | null | undefined,
  options: Record<string, unknown> = {},
  meta_data: Record<string, unknown> = {},
) {
  const headers = (request.headers ?? {}) as Record<string, unknown>;
  const now = new Date();
  const user = request.user;

  const userId =
    options.userId ??
    user?.id ??
    meta_data.user_id ??
    null;

  const userType =
    options.userType ??
    user?.type ??
    meta_data.user_type ??
    null;

  const deviceId =
    options.deviceId ??
    headers["x-device-id"] ??
    meta_data.device_id ??
    null;

  const sessionId =
    options.sessionId ??
    headers["x-session-id"] ??
    meta_data.session_id ??
    null;

  const clientId =
    options.clientId ??
    headers["x-client-id"] ??
    meta_data.client_id ??
    null;

  const requestId = request.id ?? null;

  const traceId =
    headers["x-trace-id"] ??
    headers["x-request-id"] ??
    requestId ??
    null;

  const metadata = {
    identity: {
      user_id: userId,
      user_type: userType,
      device_id: deviceId,
      session_id: sessionId,
      client_id: clientId,
    },
    event: {
      id: meta_data.event_id ?? null,
      type: meta_data.event_type ?? null,
      name: meta_data.event_name ?? null,
      timestamp: meta_data.timestamp ?? now.toISOString(),
    },
    user: {
      id: userId,
      type: userType,
    },
    session: {
      id: sessionId,
    },
    device: {
      id: deviceId,
      type: meta_data.device_type ?? null,
      model: meta_data.device_model ?? null,
      manufacturer: meta_data.device_manufacturer ?? null,
      os: meta_data.os ?? null,
      os_version: meta_data.os_version ?? null,
      architecture: meta_data.architecture ?? null,
      cpu_cores: meta_data.cpu_cores ?? null,
      memory: meta_data.memory ?? null,
      touch_support: meta_data.touch_support ?? null,
    },
    browser: {
      name: meta_data.browser_name ?? null,
      version: meta_data.browser_version ?? null,
      user_agent: meta_data.user_agent ?? headers["user-agent"] ?? null,
      language: meta_data.language ?? headers["accept-language"] ?? null,
      languages: Array.isArray(meta_data.languages) ? meta_data.languages : [],
      platform: meta_data.platform ?? headers["x-platform"] ?? null,
      vendor: meta_data.vendor ?? null,
      cookies_enabled: meta_data.cookies_enabled ?? null,
      do_not_track: meta_data.do_not_track ?? null,
    },
    screen: {
      width: meta_data.screen_width ?? null,
      height: meta_data.screen_height ?? null,
      available_width: meta_data.screen_available_width ?? null,
      available_height: meta_data.screen_available_height ?? null,
      color_depth: meta_data.color_depth ?? null,
      pixel_depth: meta_data.pixel_depth ?? null,
      pixel_ratio: meta_data.pixel_ratio ?? null,
      orientation: meta_data.orientation ?? null,
    },
    network: {
      ip: request.ip ?? null,
      ipv4: meta_data.ipv4 ?? null,
      ipv6: meta_data.ipv6 ?? null,
      connection_type: meta_data.connection_type ?? null,
      effective_type: meta_data.effective_type ?? null,
      carrier: meta_data.carrier ?? null,
      country: meta_data.country ?? null,
      region: meta_data.region ?? null,
      city: meta_data.city ?? null,
      timezone: meta_data.timezone ?? headers["x-timezone"] ?? null,
    },
    page: {
      url: meta_data.url ?? headers["x-page-url"] ?? null,
      origin: meta_data.origin ?? headers.origin ?? null,
      path: meta_data.path ?? null,
      referrer: meta_data.referrer ?? headers.referer ?? headers.referrer ?? null,
      title: meta_data.title ?? null,
    },
    request: {
      id: requestId,
      method: request.method ?? null,
      url: request.url ?? null,
      route: request.routeOptions?.url ?? null,
      hostname: request.hostname ?? null,
      host: headers.host ?? null,
      protocol: request.protocol ?? null,
      http_version: request.raw?.httpVersion ?? null,
      query: request.query ?? {},
      params: request.params ?? {},
    },
    request_data: {
      query: request.query ?? {},
      params: request.params ?? {},
      body: options.includeBody ? request.body ?? null : undefined,
    },
    response: {
      status_code: reply?.statusCode ?? null,
    },
    performance: {
      load_time: meta_data.load_time ?? null,
      dom_ready: meta_data.dom_ready ?? null,
      response_time: meta_data.response_time ?? null,
      latency: meta_data.latency ?? null,
      server_processing_time: typeof options.startedAt === "number"
        ? Date.now() - options.startedAt
        : null,
    },
    trace: {
      trace_id: traceId,
      span_id: headers["x-span-id"] ?? null,
      parent_span_id: headers["x-parent-span-id"] ?? null,
      sampled: headers["x-sampled"] ?? null,
      trace_flags: headers["x-trace-flags"] ?? null,
      trace_state: headers["x-trace-state"] ?? null,
    },
    security: {
      ip: request.ip ?? null,
      ips: request.ips ?? [],
      x_forwarded_for: headers["x-forwarded-for"] ?? null,
      forwarded: headers.forwarded ?? null,
      via: headers.via ?? null,
      real_ip: headers["x-real-ip"] ?? null,
      cloudflare_ip: headers["cf-connecting-ip"] ?? null,
    },
    application: {
      app_version: meta_data.app_version ?? headers["x-app-version"] ?? null,
      platform: meta_data.platform ?? headers["x-platform"] ?? null,
      client_id: clientId,
    },
    server: {
      node_version: process.version,
      environment: process.env.NODE_ENV ?? null,
      platform: process.platform ?? null,
      architecture: process.arch ?? null,
    },
    custom: isPlainObject(meta_data.custom) ? meta_data.custom : {},
    collected_at: now.toISOString(),
  };

  return removeUndefined(metadata);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefined(entry)]),
    );
  }

  return value;
}
