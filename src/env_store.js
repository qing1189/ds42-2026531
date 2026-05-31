// Shared .env read-modify-write helper.
// Used by auth.js (DS_TOKENS) and access.js (API_KEYS / PANEL_PASSWORD) so that
// concurrent updates preserve each other's lines, comments and blank lines.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env');

export function getEnvPath() {
  return ENV_PATH;
}

// Update or insert one or more KEY=VALUE pairs in .env, preserving everything else.
// Returns true if the file was written successfully, false otherwise (e.g. read-only mount).
export function updateEnvVars(vars) {
  let lines = [];
  try {
    lines = readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
  } catch {
    // No .env yet — start fresh (token/key persistence is best-effort).
    lines = [];
  }

  for (const [key, rawValue] of Object.entries(vars)) {
    const value = rawValue ?? '';
    const newLine = `${key}=${value}`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      // Match an active assignment for this key (skip commented "# KEY=" lines).
      if (lines[i].startsWith(`${key}=`)) {
        lines[i] = newLine;
        found = true;
        break;
      }
    }
    if (!found) lines.push(newLine);
  }

  try {
    writeFileSync(ENV_PATH, lines.join('\n'));
    return true;
  } catch (err) {
    console.warn(`Failed to persist to .env (${err.message}) — change kept in memory only`);
    return false;
  }
}
