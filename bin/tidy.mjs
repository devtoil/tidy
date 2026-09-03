#!/usr/bin/env node
import { run } from '../src/cli.mjs'

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`tidy: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
