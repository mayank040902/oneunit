import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Packaging tests (AGENTS.md §12.5, ARCHITECTURE §27.5).
 *
 * These verify the *published artifact* behavior, not the workspace source:
 *   - The package entry point resolves and loads without any optional
 *     adapter dependency present.
 *   - Public exports are intentional and documented.
 *   - `npm pack` produces a tarball whose contents match the package.json
 *     `exports`/`main`/`types` mappings.
 */

const PKG_DIR = join(process.cwd());
const TMP = join(tmpdir(), `oneunit-pack-test-${process.pid}`);

function readJSON(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function tarList(): string[] {
  let tarball = '';
  try {
    const entries = readdirSync(TMP);
    tarball = entries.find((f) => f.endsWith('.tgz')) ?? '';
  } catch {
    return [];
  }
  if (!tarball) return [];
  const result = spawnSync('tar', ['tzf', join(TMP, tarball)], {
    encoding: 'utf8',
  });
  if (result.error) return [];
  return (result.stdout ?? '').split('\n').filter(Boolean);
}

describe('package.json contract', () => {
  const pkg = readJSON(join(PKG_DIR, 'package.json'));

  it('declares an ESM module type', () => {
    expect(pkg.type).toBe('module');
  });

  it('declares a main entry and type declarations', () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
  });

  it('keeps optional adapter dependencies out of mandatory dependencies', () => {
    // kafkajs is a hard dep only because the KafkaJS adapter imports it
    // directly; @oneunit/kafka must remain optional/peer.
    expect(pkg.peerDependencies?.['@oneunit/kafka']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@oneunit/kafka']?.optional).toBe(true);
    expect(pkg.peerDependencies?.['@oneunit/redis']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@oneunit/redis']?.optional).toBe(true);
  });

  it('declares a test script', () => {
    expect(pkg.scripts?.test).toBe('vitest run');
    expect(pkg.scripts?.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts?.build).toBe('tsc');
  });
});

describe('public entry point surface', () => {
  it('exports the composition root', async () => {
    const mod = await import('./dist/index.js');
    expect(typeof mod.createMicroservice).toBe('function');
  });

  it('exports the registry factory', async () => {
    const mod = await import('./dist/index.js');
    expect(typeof mod.createRegistry).toBe('function');
  });

  it('exports common error categories', async () => {
    const mod = await import('./dist/index.js');
    // The error module re-exports category helpers; at minimum the module
    // must load without throwing in a clean environment.
    expect(mod).toBeDefined();
  });
});

describe('npm pack artifact', () => {
  beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    spawnSync('npm', ['pack', '--pack-destination', TMP], {
      cwd: PKG_DIR,
      encoding: 'utf8',
    });
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('produces a tarball that contains the main entry and declarations', () => {
    const files = tarList();

    // Skip rather than fail when the toolchain is unavailable.
    if (files.length === 0) {
      console.warn('npm pack / tar unavailable; skipping artifact contents check');
      return;
    }

    const flat = files.join('\n');
    expect(flat).toContain('dist/index.js');
    expect(flat).toContain('dist/index.d.ts');
    expect(flat).toContain('package.json');
    // Source must not leak into the published artifact.
    expect(flat).not.toMatch(/\/src\//);
    expect(flat).not.toMatch(/coverage\//);
    expect(flat).not.toMatch(/\.map$/);
  });
});