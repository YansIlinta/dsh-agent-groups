#!/usr/bin/env node
/**
 * Build the DSH-native client bundle for Agent Groups.
 *
 * Reads packages/host/src/native-client/index.js (plain CommonJS, no JSX,
 * environment provides require/module/exports/React/primitives) and appends
 * the Create Flow workspace extension from create-flow.js before wrapping both
 * in the DSH client-modules bundle format.
 *
 * Output: packages/host/lib/client.js — served by dsh-client-modules at
 * /plugins/<id>/client.js once the web profile declares this package's
 * `dsh.client` field (see package.json, inject list).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = join(ROOT, 'packages', 'host')
const SRC = join(HOST, 'src', 'native-client', 'index.js')
const CREATE_FLOW_SRC = join(HOST, 'src', 'native-client', 'create-flow.js')
const OUT = join(HOST, 'lib', 'client.js')

const pkg = JSON.parse(readFileSync(join(HOST, 'package.json'), 'utf8'))

const source = readFileSync(SRC, 'utf8')
const createFlowSource = readFileSync(CREATE_FLOW_SRC, 'utf8')
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tvar React = require("react");
\t\tvar primitives = require("@deepseek-ai/dsh-client-ui-primitives");
${source}

// ── Create Flow native workspace extension ────────────────────────────────
${createFlowSource}
\t\treturn module.exports;
\t}
});
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, bundle)
console.log(`[native-client] wrote ${OUT} (${bundle.length} bytes) for ${pkg.name}`)
