/**
 * Web Crypto API Envelope Encryption for Secrets
 *
 * Envelope encryption:
 * - Each secret gets a unique Data Encryption Key (DEK)
 * - The DEK encrypts the secret using AES-256-GCM
 * - The DEK is encrypted by a Key Encryption Key (KEK) using AES-256-GCM
 * - Both the encrypted DEK and ciphertext are stored in D1
 * - The KEK is stored in Cloudflare Secret Store and never leaves
 *
 * Key format: workspaces/{workspaceId}/providers/{providerId}/{secretKey}
 */


// Version identifier for encrypted blobs (for future format changes)
const VERSION = 1;

/**
 * Encrypted secret envelope stored in D1
 */
export interface EncryptedSecretEnvelope {
  /** Format version for forward compatibility */
  v: number;
  /** Base64-encoded encrypted DEK */
  edek: string;
  /** Base64-encoded encrypted secret ciphertext */
  ct: string;
  /** Base64-encoded AES-GCM nonce for ciphertext */
  nonce: string;
  /** Created at timestamp (Unix ms) */
  createdAt: number;
}

/**
 * Generate a new random AES-256-GCM key (used as DEK)
 */
export async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable - we need to encrypt it
    ["encrypt", "decrypt"]
  ) as Promise<CryptoKey>;
}

/**
 * Import KEK from raw bytes (32 bytes for AES-256)
 */
export async function importKEK(keyData: Uint8Array): Promise<CryptoKey> {
  if (keyData.length !== 32) {
    throw new Error(`Invalid KEK length: expected 32 bytes, got ${keyData.length}`);
  }
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false, // not extractable - KEK stays in memory only
    ["encrypt", "decrypt"]
  );
}

/**
 * Generate a new KEK (32 random bytes)
 */
export function generateKEK(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Export a crypto key to raw bytes
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(exported as ArrayBuffer);
}

/**
 * Generate a cryptographically secure random nonce
 */
export function generateNonce(length: number = 12): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Encrypt data using AES-256-GCM
 * Returns the nonce concatenated with the ciphertext
 */
export async function encrypt(
  plaintext: Uint8Array,
  key: CryptoKey
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = generateNonce(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    plaintext
  );
  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
  };
}

/**
 * Decrypt data using AES-256-GCM
 * Expects nonce concatenated with ciphertext
 */
export async function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

/**
 * Envelope encrypt a secret:
 * 1. Generate a new DEK
 * 2. Encrypt the secret with the DEK
 * 3. Encrypt the DEK with the KEK
 * 4. Return the envelope
 */
export async function envelopeEncrypt(
  plaintext: string,
  kek: CryptoKey
): Promise<EncryptedSecretEnvelope> {
  // Generate DEK
  const dek = await generateDEK();

  // Encrypt secret with DEK
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const { ciphertext, nonce } = await encrypt(plaintextBytes, dek);

  // Export DEK and encrypt with KEK
  const dekBytes = await exportKey(dek);
  const { ciphertext: edekCiphertext, nonce: edekNonce } = await encrypt(dekBytes, kek);

  // Combine EDek nonce + ciphertext for storage
  const edekCombined = new Uint8Array(edekNonce.length + edekCiphertext.length);
  edekCombined.set(edekNonce);
  edekCombined.set(edekCiphertext, edekNonce.length);

  return {
    v: VERSION,
    edek: encodeBase64(edekCombined),
    ct: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    createdAt: Date.now(),
  };
}

/**
 * Envelope decrypt a secret:
 * 1. Decrypt the DEK using the KEK
 * 2. Decrypt the ciphertext using the DEK
 * 3. Return the plaintext
 */
export async function envelopeDecrypt(
  envelope: EncryptedSecretEnvelope,
  kek: CryptoKey
): Promise<string> {
  if (envelope.v !== VERSION) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }

  // Decode EDek and extract nonce + ciphertext
  const edekCombined = decodeBase64(envelope.edek);
  const edekNonce = edekCombined.slice(0, 12);
  const edekCiphertext = edekCombined.slice(12);

  // Decrypt DEK with KEK
  const dekBytes = await decrypt(edekCiphertext, edekNonce, kek);

  // Import DEK
  const dek = await crypto.subtle.importKey(
    "raw",
    dekBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  // Decrypt ciphertext with DEK
  const ciphertext = decodeBase64(envelope.ct);
  const nonce = decodeBase64(envelope.nonce);
  const plaintextBytes = await decrypt(ciphertext, nonce, dek);

  return new TextDecoder().decode(plaintextBytes);
}

/**
 * Encode Uint8Array to base64 string
 */
export function encodeBase64(data: Uint8Array): string {
  // Use Cloudflare Workers' built-in base64 encoding
  return btoa(String.fromCharCode(...data));
}

/**
 * Decode base64 string to Uint8Array
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
