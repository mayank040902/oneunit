import { describe, it, expect } from 'vitest';
import {
  ContractVersion,
  VersionedContract,
  parseVersion,
  formatVersion,
  isCompatible,
  getLatestVersion,
  isDeprecated,
} from '../../src/contracts/versions.js';

describe('ContractVersion', () => {
  it('should define version structure', () => {
    const version: ContractVersion = { major: 1, minor: 2, patch: 3 };
    expect(version.major).toBe(1);
    expect(version.minor).toBe(2);
    expect(version.patch).toBe(3);
  });

  it('should allow zero versions', () => {
    const version: ContractVersion = { major: 0, minor: 0, patch: 0 };
    expect(version.major).toBe(0);
  });
});

describe('VersionedContract', () => {
  it('should define versioned contract structure', () => {
    const contract: VersionedContract<{ name: string }> = {
      version: { major: 1, minor: 0, patch: 0 },
      contract: { name: 'test' },
      supportedVersions: [{ major: 1, minor: 0, patch: 0 }],
      deprecatedVersions: [],
    };

    expect(contract.version.major).toBe(1);
    expect(contract.contract.name).toBe('test');
    expect(contract.supportedVersions).toHaveLength(1);
    expect(contract.deprecatedVersions).toHaveLength(0);
  });
});

describe('parseVersion', () => {
  it('should parse valid version string', () => {
    const version = parseVersion('1.2.3');
    expect(version).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('should parse version with zero values', () => {
    const version = parseVersion('0.0.0');
    expect(version).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('should parse version with large numbers', () => {
    const version = parseVersion('10.20.30');
    expect(version).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('should throw for invalid format - too few parts', () => {
    expect(() => parseVersion('1.2')).toThrow('Invalid version format: 1.2');
  });

  it('should throw for invalid format - too many parts', () => {
    expect(() => parseVersion('1.2.3.4')).toThrow('Invalid version format: 1.2.3.4');
  });

  it('should throw for non-numeric parts', () => {
    expect(() => parseVersion('1.a.3')).toThrow('Invalid version format: 1.a.3');
  });

  it('should throw for empty string', () => {
    expect(() => parseVersion('')).toThrow('Invalid version format: ');
  });

  it('should parse negative numbers as valid (JavaScript behavior)', () => {
    const version = parseVersion('-1.2.3');
    expect(version).toEqual({ major: -1, minor: 2, patch: 3 });
  });

  it('should throw for NaN parts', () => {
    expect(() => parseVersion('1.2.abc')).toThrow('Invalid version format: 1.2.abc');
  });
});

describe('formatVersion', () => {
  it('should format version to string', () => {
    const version: ContractVersion = { major: 1, minor: 2, patch: 3 };
    expect(formatVersion(version)).toBe('1.2.3');
  });

  it('should format zero version', () => {
    const version: ContractVersion = { major: 0, minor: 0, patch: 0 };
    expect(formatVersion(version)).toBe('0.0.0');
  });

  it('should format large numbers', () => {
    const version: ContractVersion = { major: 10, minor: 20, patch: 30 };
    expect(formatVersion(version)).toBe('10.20.30');
  });

  it('should be inverse of parseVersion', () => {
    const original = '2.5.8';
    const parsed = parseVersion(original);
    const formatted = formatVersion(parsed);
    expect(formatted).toBe(original);
  });
});

describe('isCompatible', () => {
  const serverVersions: ContractVersion[] = [
    { major: 1, minor: 0, patch: 0 },
    { major: 1, minor: 1, patch: 0 },
    { major: 1, minor: 2, patch: 5 },
    { major: 2, minor: 0, patch: 0 },
  ];

  it('should return true for exact match', () => {
    const clientVersion: ContractVersion = { major: 1, minor: 1, patch: 0 };
    expect(isCompatible(clientVersion, serverVersions)).toBe(true);
  });

  it('should return true when server has higher minor version', () => {
    const clientVersion: ContractVersion = { major: 1, minor: 0, patch: 0 };
    expect(isCompatible(clientVersion, serverVersions)).toBe(true);
  });

  it('should return true when server has higher patch version', () => {
    const clientVersion: ContractVersion = { major: 1, minor: 2, patch: 0 };
    expect(isCompatible(clientVersion, serverVersions)).toBe(true);
  });

  it('should return false when major version differs', () => {
    const clientVersion: ContractVersion = { major: 2, minor: 0, patch: 0 };
    expect(isCompatible(clientVersion, serverVersions)).toBe(true); // 2.0.0 matches 2.0.0
    
    const clientVersionOld: ContractVersion = { major: 0, minor: 9, patch: 0 };
    expect(isCompatible(clientVersionOld, serverVersions)).toBe(false);
  });

  it('should return false when server minor is lower', () => {
    const clientVersion: ContractVersion = { major: 1, minor: 3, patch: 0 };
    expect(isCompatible(clientVersion, serverVersions)).toBe(false);
  });

  it('should return false for empty server versions', () => {
    const clientVersion: ContractVersion = { major: 1, minor: 0, patch: 0 };
    expect(isCompatible(clientVersion, [])).toBe(false);
  });

  it('should handle multiple major versions', () => {
    const multiMajor: ContractVersion[] = [
      { major: 1, minor: 5, patch: 0 },
      { major: 2, minor: 3, patch: 1 },
    ];
    
    expect(isCompatible({ major: 1, minor: 3, patch: 0 }, multiMajor)).toBe(true);
    expect(isCompatible({ major: 2, minor: 2, patch: 0 }, multiMajor)).toBe(true); // 2.2.0 <= 2.3.1
    expect(isCompatible({ major: 2, minor: 3, patch: 0 }, multiMajor)).toBe(true);
    expect(isCompatible({ major: 2, minor: 4, patch: 0 }, multiMajor)).toBe(false); // 2.4.0 > 2.3.1
  });
});

describe('getLatestVersion', () => {
  it('should return latest version from array', () => {
    const versions: ContractVersion[] = [
      { major: 1, minor: 0, patch: 0 },
      { major: 1, minor: 2, patch: 3 },
      { major: 1, minor: 1, patch: 5 },
      { major: 2, minor: 0, patch: 0 },
    ];
    
    const latest = getLatestVersion(versions);
    expect(latest).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it('should compare major first', () => {
    const versions: ContractVersion[] = [
      { major: 1, minor: 9, patch: 9 },
      { major: 2, minor: 0, patch: 0 },
    ];
    
    const latest = getLatestVersion(versions);
    expect(latest).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it('should compare minor when major is equal', () => {
    const versions: ContractVersion[] = [
      { major: 1, minor: 2, patch: 0 },
      { major: 1, minor: 1, patch: 9 },
    ];
    
    const latest = getLatestVersion(versions);
    expect(latest).toEqual({ major: 1, minor: 2, patch: 0 });
  });

  it('should compare patch when major and minor are equal', () => {
    const versions: ContractVersion[] = [
      { major: 1, minor: 2, patch: 5 },
      { major: 1, minor: 2, patch: 3 },
    ];
    
    const latest = getLatestVersion(versions);
    expect(latest).toEqual({ major: 1, minor: 2, patch: 5 });
  });

  it('should throw for empty array', () => {
    expect(() => getLatestVersion([])).toThrow('No versions provided');
  });

  it('should handle single version', () => {
    const versions: ContractVersion[] = [{ major: 1, minor: 0, patch: 0 }];
    const latest = getLatestVersion(versions);
    expect(latest).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});

describe('isDeprecated', () => {
  const deprecatedVersions: ContractVersion[] = [
    { major: 1, minor: 0, patch: 0 },
    { major: 2, minor: 5, patch: 0 },
  ];

  it('should return true for deprecated version', () => {
    expect(isDeprecated({ major: 1, minor: 0, patch: 5 }, deprecatedVersions)).toBe(true);
    expect(isDeprecated({ major: 2, minor: 5, patch: 10 }, deprecatedVersions)).toBe(true);
  });

  it('should return false for non-deprecated version', () => {
    expect(isDeprecated({ major: 1, minor: 1, patch: 0 }, deprecatedVersions)).toBe(false);
    expect(isDeprecated({ major: 2, minor: 4, patch: 0 }, deprecatedVersions)).toBe(false);
    expect(isDeprecated({ major: 3, minor: 0, patch: 0 }, deprecatedVersions)).toBe(false);
  });

  it('should match on major and minor only', () => {
    expect(isDeprecated({ major: 1, minor: 0, patch: 999 }, deprecatedVersions)).toBe(true);
    expect(isDeprecated({ major: 2, minor: 5, patch: 999 }, deprecatedVersions)).toBe(true);
  });

  it('should return false for empty deprecated list', () => {
    expect(isDeprecated({ major: 1, minor: 0, patch: 0 }, [])).toBe(false);
  });
});