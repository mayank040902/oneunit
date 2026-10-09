export interface ContractVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface VersionedContract<T> {
  version: ContractVersion;
  contract: T;
  supportedVersions: ContractVersion[];
  deprecatedVersions: ContractVersion[];
}

export function parseVersion(version: string): ContractVersion {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  const [major, minor, patch] = parts;
  return { major: major!, minor: minor!, patch: patch! };
}

export function formatVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function isCompatible(
  clientVersion: ContractVersion,
  serverVersions: ContractVersion[]
): boolean {
  return serverVersions.some(v => 
    v.major === clientVersion.major && 
    v.minor >= clientVersion.minor
  );
}

export function getLatestVersion(versions: ContractVersion[]): ContractVersion {
  if (versions.length === 0) {
    throw new Error('No versions provided');
  }
  return versions.reduce((latest, current) => {
    if (current.major > latest.major) return current;
    if (current.major === latest.major && current.minor > latest.minor) return current;
    if (current.major === latest.major && current.minor === latest.minor && current.patch > latest.patch) return current;
    return latest;
  });
}

export function isDeprecated(version: ContractVersion, deprecatedVersions: ContractVersion[]): boolean {
  return deprecatedVersions.some(v => 
    v.major === version.major && 
    v.minor === version.minor
  );
}