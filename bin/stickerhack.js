#!/usr/bin/env node

import { main } from "../lib/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`stickerhack: ${message}`);
  process.exit(1);
});
