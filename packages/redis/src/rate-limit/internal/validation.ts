 
import { RateLimitConfigError } from "../errors.js";

export function validatePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RateLimitConfigError(`${name} must be a positive finite number`, name);
  }
}

export function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RateLimitConfigError(`${name} must be a non-negative integer`, name);
  }
}

export function validateWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RateLimitConfigError("weight must be a positive finite number", "weight");
  }
}
