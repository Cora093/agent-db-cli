#!/usr/bin/env node
import { run } from './app.js';

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`internal: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
