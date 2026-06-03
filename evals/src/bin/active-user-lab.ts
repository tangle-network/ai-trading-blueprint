import {
  DEFAULT_APP_URL,
  DEFAULT_LIN_LOGIN,
  DEFAULT_OPERATOR_URL,
  DEFAULT_REPO,
  auditLinIssues,
  dispatchActiveUserLab,
  formatAuditTable,
} from '../product/active-user-lab.js'

const command = process.argv[2] && !process.argv[2]!.startsWith('--') ? process.argv[2]! : 'audit'

if (command === 'help' || hasFlag('--help') || hasFlag('-h')) {
  printHelp()
  process.exit(0)
}

const baseOptions = {
  repo: valueAfter('--repo') ?? DEFAULT_REPO,
  linLogin: valueAfter('--lin') ?? DEFAULT_LIN_LOGIN,
  operatorUrl: valueAfter('--operator-url') ?? process.env.TRADING_OPERATOR_API_URL ?? DEFAULT_OPERATOR_URL,
  githubToken: valueAfter('--github-token') ?? process.env.GITHUB_TOKEN,
  includeEvidence: !hasFlag('--no-evidence'),
}

if (command === 'audit') {
  const report = await auditLinIssues(baseOptions)
  console.log(hasFlag('--json') ? JSON.stringify(report, null, 2) : formatAuditTable(report))
} else if (command === 'dispatch' || command === 'run') {
  const results = await dispatchActiveUserLab({
    ...baseOptions,
    appUrl: valueAfter('--app-url') ?? process.env.TRADING_ARENA_APP_URL ?? DEFAULT_APP_URL,
    token: valueAfter('--token') ?? process.env.TRADING_OPERATOR_SESSION_TOKEN ?? process.env.OPERATOR_SESSION_TOKEN,
    privateKey: valueAfter('--private-key') ?? process.env.TRADING_OPERATOR_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY,
    issueNumbers: issueNumbersFromArgs(),
    botId: valueAfter('--bot'),
    turns: numberAfter('--turns'),
    watch: hasFlag('--watch'),
    replyTimeoutMs: numberAfter('--reply-timeout-ms'),
    pollIntervalMs: numberAfter('--poll-ms'),
    prompts: valuesAfter('--prompt'),
    generateIdeas: hasFlag('--generate-ideas'),
    configureSecrets: hasFlag('--configure-secrets'),
    freshBot: hasFlag('--fresh-bot'),
    dryRun: hasFlag('--dry-run'),
  })
  if (hasFlag('--json')) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const result of results) {
      console.log(`\n#${result.issueNumber} ${result.issueTitle}`)
      console.log(`bot: ${result.botName} (${result.botId})`)
      console.log(`session: ${result.sessionId}`)
      console.log(`app: ${result.chatUrl}`)
      result.replies.forEach((reply, index) => {
        console.log(`\nturn ${index + 1}: ${reply.prompt}`)
        console.log(reply.endedBy === 'reply' ? `reply: ${reply.reply}` : `reply: ${reply.endedBy}`)
      })
    }
  }
} else {
  throw new Error(`unknown command "${command}". Run: npm run agent:user-lab -- help`)
}

function printHelp(): void {
  console.log(`Active user lab

Usage:
  npm run agent:user-lab -- audit [--json]
  npm run agent:user-lab -- dispatch --issue 46 --watch

Commands:
  audit       List Lin's open issues and map each one to live bot coverage.
  dispatch   Create real bot chat sessions, send multi-shot prompts, and print app links.

Common options:
  --repo owner/name              Default: ${DEFAULT_REPO}
  --lin login                    Default: ${DEFAULT_LIN_LOGIN}
  --operator-url url             Default: ${DEFAULT_OPERATOR_URL}
  --app-url url                  Default: ${DEFAULT_APP_URL}
  --json                         Emit JSON.

Dispatch options:
  --issue 46,45                  Issue numbers to dispatch. Default: 57,46,45,41,9.
  --bot id                       Force one bot for the selected issue.
  --turns n                      Number of turns per issue. Default: 3.
  --prompt text                  Repeat to provide exact prompts instead of scenario prompts.
  --generate-ideas               Use agent-runtime to compose prompt ideas before dispatch.
  --fresh-bot                    Provision an owned paper QA bot before dispatching prompts.
  --watch                        Poll for assistant replies after each turn.
  --configure-secrets            Inject local deterministic LLM secrets before dispatch.
  --token token                  Operator session token. Also reads OPERATOR_SESSION_TOKEN.
  --private-key key              Operator private key; authenticates via cast.
  --dry-run                      Build sessions/prompts/links without sending messages.
`)
}

function issueNumbersFromArgs(): number[] | undefined {
  const raw = valuesAfter('--issue').flatMap((value) => value.split(','))
  if (raw.length === 0) return undefined
  return raw.map((value) => {
    const parsed = Number(value.trim())
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid --issue value: ${value}`)
    return parsed
  })
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function valuesAfter(flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== flag) continue
    const value = process.argv[i + 1]
    if (value && !value.startsWith('--')) values.push(value)
  }
  return values
}

function numberAfter(flag: string): number | undefined {
  const value = valueAfter(flag)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`)
  return parsed
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}
