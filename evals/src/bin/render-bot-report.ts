#!/usr/bin/env node
/**
 * CLI for the S-tier per-bot report renderer (SPEC.md §4).
 *
 * Usage:
 *   # render from a real JSON eval bundle:
 *   npx tsx evals/src/bin/render-bot-report.ts --in path/to/bot-data.json --out report.md
 *
 *   # render from the built-in synthetic fixture (smoke + visual review):
 *   npx tsx evals/src/bin/render-bot-report.ts --fixture --out fixture-report.md
 *
 * The output is GitHub-flavored markdown with inline SVG charts. Open the
 * resulting `.md` in any markdown viewer that renders inline SVG (GitHub,
 * VS Code preview, glow) to see the S-tier shape.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { makeFixtureReport } from '../report/fixture.js'
import { renderBotReport } from '../report/render.js'
import type { BotReportData } from '../report/types.js'

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const inPath = argValue('--in')
  const outPath = argValue('--out') ?? '/tmp/bot-report.md'
  const useFixture = process.argv.includes('--fixture')

  let data: BotReportData
  if (useFixture) {
    data = makeFixtureReport()
    process.stderr.write('Using synthetic fixture data (not from a real eval run)\n')
  } else if (inPath) {
    data = JSON.parse(readFileSync(resolve(process.cwd(), inPath), 'utf8')) as BotReportData
    process.stderr.write(`Loaded eval data from ${inPath}\n`)
  } else {
    process.stderr.write('error: pass --fixture or --in <path>\n')
    process.exit(2)
  }

  const md = await renderBotReport(data)
  const absOut = resolve(process.cwd(), outPath)
  mkdirSync(dirname(absOut), { recursive: true })
  writeFileSync(absOut, md, 'utf8')
  process.stderr.write(`Wrote ${md.length} bytes → ${absOut}\n`)
  console.log(absOut)
}

await main()
