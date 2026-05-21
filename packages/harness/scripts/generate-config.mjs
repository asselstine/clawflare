#!/usr/bin/env node
/**
 * Generate wrangler.jsonc from wrangler.template.jsonc
 * Substitutes environment variables into template placeholders
 * 
 * Usage: node scripts/generate-config.mjs
 * 
 * Required environment variables:
 *   - DATABASE_ID
 *   - PREVIEW_DATABASE_ID
 *   - AI_PROVIDER (optional, defaults to 'amazon-bedrock')
 *   - AI_MODEL (optional, defaults to 'minimax.minimax-m2.5')
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const requiredEnvVars = ['DATABASE_ID'];
const optionalEnvVars = {
  'AI_PROVIDER': 'amazon-bedrock',
  'AI_MODEL': 'minimax.minimax-m2.5',
  'PREVIEW_DATABASE_ID': process.env['DATABASE_ID']
};

// Validate required env vars
const missing = requiredEnvVars.filter(name => !process.env[name]);
if (missing.length > 0) {
  console.error('Error: Missing required environment variables:');
  missing.forEach(name => console.error(`  - ${name}`));
  process.exit(1);
}

// Collect substitutions
const substitutions = {};

for (const name of requiredEnvVars) {
  substitutions[name] = process.env[name];
}

for (const [name, defaultValue] of Object.entries(optionalEnvVars)) {
  substitutions[name] = process.env[name] || defaultValue;
}

// Read template
const templatePath = join(rootDir, 'wrangler.template.jsonc');
let content = await readFile(templatePath, 'utf-8');

// Perform substitutions
for (const [name, value] of Object.entries(substitutions)) {
  const placeholder = `{{${name}}}`;
  if (!content.includes(placeholder)) {
    console.warn(`Warning: Placeholder ${placeholder} not found in template`);
  }
  content = content.replaceAll(placeholder, value);
}

// Check for remaining placeholders
const remaining = content.match(/\{\{[A-Z_]+\}\}/g);
if (remaining) {
  console.warn('Warning: Unsubstituted placeholders remain:', [...new Set(remaining)]);
}

// Write output
const outputPath = join(rootDir, 'wrangler.jsonc');
await writeFile(outputPath, content, 'utf-8');

console.log('Generated wrangler.jsonc with:');
for (const [name, value] of Object.entries(substitutions)) {
  const display = name.includes('TOKEN') || name.includes('SECRET') 
    ? `${value.slice(0, 8)}...` 
    : value;
  console.log(`  ${name}: ${display}`);
}
console.log(`\nOutput written to: ${outputPath}`);
