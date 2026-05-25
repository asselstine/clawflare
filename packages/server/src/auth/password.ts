// Password hashing utilities for native email/password auth
// Uses PBKDF2-HMAC-SHA-256 which is available in Cloudflare Workers Web Crypto

const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Generate a cryptographically secure random string
 */
function generateRandomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

/**
 * Hash a password using PBKDF2-HMAC-SHA-256
 * Format: iterations:salt:hash (all hex encoded)
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = generateRandomString(SALT_LENGTH);
  
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8
  );
  
  const hash = Array.from(new Uint8Array(derivedBits), (b) =>
    (b & 0xff).toString(16).padStart(2, "0")
  ).join("");
  
  return `${ITERATIONS}:${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3) return false;
  
  const [iterationsStr, salt, expectedHash] = parts;
  if (!iterationsStr || !salt || !expectedHash) return false;
  
  const iterations = parseInt(iterationsStr, 10);
  
  if (isNaN(iterations) || iterations < 1) return false;
  
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    expectedHash.length * 4
  );
  
  const actualHash = Array.from(new Uint8Array(derivedBits), (b) =>
    (b & 0xff).toString(16).padStart(2, "0")
  ).join("");
  
  // Constant-time comparison
  if (actualHash.length !== expectedHash.length) return false;
  
  let result = 0;
  for (let i = 0; i < actualHash.length; i++) {
    result |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Check password strength
 * Returns { valid: boolean, errors: string[] }
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (password.length < 15) {
    errors.push("Password must be at least 15 characters");
  }
  
  if (password.length > 256) {
    errors.push("Password must be less than 256 characters");
  }
  
  // Check for common weak patterns (basic check)
  const commonPatterns = [
    /^password/i,
    /^admin/i,
    /^123456/,
    /^qwerty/i,
    /^(.)\1{5,}/, // Repeated characters
  ];
  
  for (const pattern of commonPatterns) {
    if (pattern.test(password)) {
      errors.push("Password is too common or easily guessable");
      break;
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normalize email for storage and lookup
 * Lowercase and trim
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
