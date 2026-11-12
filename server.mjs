#!/usr/bin/env node
// Decision Room — local bridge to installed model CLIs.
// Entry point for `npm start`, the macOS launcher and `node server.mjs [--check | --no-open | --help]`.
// The application lives in src/; importing this file does not start it.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './src/main.mjs';

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) start();
