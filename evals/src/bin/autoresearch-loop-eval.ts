import { runAutoresearchLoop } from '../product/autoresearch-loop-runner.js'

const options: Parameters<typeof runAutoresearchLoop>[0] = {}
const inputs = valuesAfter('--input')
if (inputs.length > 0) options.input = inputs
const out = valueAfter('--out')
if (out) options.outputPath = out
const trajectoryDir = valueAfter('--trajectory-dir')
if (trajectoryDir) options.trajectoryDir = trajectoryDir
const runsJsonl = valueAfter('--runs-jsonl')
if (runsJsonl) options.runsJsonl = runsJsonl
const model = valueAfter('--model')
if (model) options.model = model
const baseUrl = valueAfter('--base-url')
if (baseUrl) options.baseUrl = baseUrl
if (process.argv.includes('--skip-judge')) options.skipJudge = true

const report = await runAutoresearchLoop(options)
console.log(JSON.stringify({
  suite: report.suite,
  output: report.output,
  trajectories: report.judged.length,
  scores: report.judged.map((item) => ({
    id: item.id,
    overall_score: item.judge.overall_score,
    verdict: item.judge.verdict,
    failures: item.judge.failures,
  })),
  promoted_policy: report.promoted_policy,
  assertions: report.assertions,
}, null, 2))

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function valuesAfter(flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) {
      values.push(process.argv[i + 1]!)
    }
  }
  return values
}
