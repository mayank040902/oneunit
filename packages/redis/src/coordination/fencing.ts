/* eslint-disable */
export function validateFencingToken(expected: number, provided: number, resource: string = ""): void {
  if (provided < expected) {
    throw new Error(`Fencing token ${provided} is older than expected ${expected} for ${resource}`.trim());
  }
}

export function compareFencingTokens(a: number, b: number): number {
  return a - b;
}

export function isStaleFencingToken(currentHighest: number, token: number): boolean {
  return token < currentHighest;
}

export function nextFencingToken(current: number): number {
  // Safe increment with overflow guard (JS max safe integer)
  if (current >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error("Fencing token overflow");
  }
  return current + 1;
}
