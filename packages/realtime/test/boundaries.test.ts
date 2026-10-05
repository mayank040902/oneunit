import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// These tests assert the boundaries ARCHITECTURE.md claims. They are cheap and
// they are the reason the claims can be trusted: a change that couples the core
// to a server or a broker fails here instead of in a review comment.

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(packageRoot, "src");

function read(name: string): string {
  return readFileSync(join(sourceDir, name), "utf8");
}

/** Import specifiers of a module, static and dynamic alike. */
function importsOf(name: string): string[] {
  const source = read(name);
  const specifiers: string[] = [];
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function bareModules(name: string): string[] {
  return importsOf(name).filter((specifier) => !specifier.startsWith("."));
}

const BROKER = /kafka|amqp|rabbit|nats|redis|sqs|pubsub|bullmq/i;

describe("module boundaries", () => {
  it("keeps the hub free of transports and brokers", () => {
    for (const dependency of bareModules("hub.ts")) {
      expect(dependency, `src/hub.ts imports ${dependency}`).not.toMatch(/^(ws|fastify|@fastify)/);
      expect(dependency, `src/hub.ts imports ${dependency}`).not.toMatch(BROKER);
    }
  });

  it("keeps the adapter free of Fastify and of brokers", () => {
    for (const dependency of bareModules("adapter.ts")) {
      expect(dependency, `src/adapter.ts imports ${dependency}`).not.toMatch(/^(fastify|@fastify)/);
      expect(dependency, `src/adapter.ts imports ${dependency}`).not.toMatch(BROKER);
    }
  });

  it("loads ws lazily, so a Fastify-only app never pays for it", () => {
    // A static `import ... from "ws"` would load ws for every consumer of the
    // hub, including the ones that only need the transport-neutral core.
    expect(read("adapter.ts")).not.toMatch(/^import\s[^\n]*from\s*["']ws["']/m);
    expect(importsOf("adapter.ts")).toContain("ws");
  });

  it("confines Fastify to the plugin", () => {
    const files = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"));
    // `fastify.ts` is the opt-in type augmentation. `import "fastify"` there is
    // erased by the build, so the published module adds a type without loading
    // Fastify; it is checked separately below.
    const allowed = new Set(["plugin.ts", "fastify.ts"]);

    for (const name of files) {
      const usesFastify = importsOf(name).some((specifier) =>
        /^(fastify|@fastify)/.test(specifier),
      );

      expect(usesFastify, `src/${name} imports Fastify`).toBe(allowed.has(name));
    }

    const augmentation = read("fastify.ts");

    expect(augmentation).toMatch(/declare module "fastify"/);
    expect(augmentation).not.toMatch(/^export (const|function|class|async)/m);
  });

  it("keeps the cryptography helpers independent of the hub", () => {
    // E2EE has to be usable without a hub, and a hub change must not silently
    // change how a frame is encrypted.
    expect(bareModules("e2ee.ts")).toEqual(["libsodium-wrappers"]);
    expect(importsOf("e2ee.ts").filter((specifier) => specifier.startsWith("."))).toEqual([]);
    expect(importsOf("errors.ts")).toEqual([]);
  });

  it("keeps the dependency arrows pointing one way", () => {
    const importers = (target: string): string[] =>
      readdirSync(sourceDir)
        .filter((name) => name.endsWith(".ts"))
        .filter((name) => importsOf(name).includes(target));

    // The hub knows nothing about transports, and the adapter is the only place
    // a server becomes a hub client, so `index.ts` and `plugin.ts` are the only
    // modules allowed to reach for it.
    expect(importers("./adapter.js").sort()).toEqual(["index.ts", "plugin.ts"]);
    expect(importers("./hub.js").sort()).toEqual([
      "adapter.ts",
      "fastify.ts",
      "index.ts",
      "plugin.ts",
    ]);
  });

  it("keeps the source layout flat", () => {
    // A flat src/ is deliberate: this package is small enough that a directory
    // tree would describe an intent the code does not have.
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        expect(entry.name, `src/${entry.name} is a directory`).not.toBe("__tests__");
      }
    }

    for (const directory of ["core", "transport", "transports", "adapters", "security"]) {
      expect(existsSync(join(sourceDir, directory)), `src/${directory} must not exist`).toBe(
        false,
      );
    }
  });
});

describe("public surface", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
    dependencies: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it("ships no broker-shaped export or subpath", async () => {
    const root = (await import("../src/index.js")) as Record<string, unknown>;

    expect(Object.keys(root).filter((name) => BROKER.test(name))).toEqual([]);
    expect(Object.keys(manifest.exports).filter((subpath) => BROKER.test(subpath))).toEqual([]);
  });

  it("declares ws as a runtime dependency, not a peer", () => {
    // The standalone adapter is a supported integration, so requiring every
    // consumer to install ws themselves would make it optional-by-accident.
    expect(manifest.dependencies.ws).toBeDefined();
    expect(Object.keys(manifest.peerDependencies ?? {}).filter((dep) => BROKER.test(dep))).toEqual(
      [],
    );
  });

  it("documents the refusal a peer sees before a handshake", () => {
    const adapter = read("adapter.ts");

    // The 401 pre-handshake refusal is the security property of the ws path, so
    // it must stay paired with authenticate() running first.
    expect(adapter.indexOf("adapter.authenticate(")).toBeLessThan(
      adapter.indexOf("wss.handleUpgrade("),
    );
  });
});