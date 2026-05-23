import { pathToFileURL } from 'node:url'

export interface AgentEvalModule {
  FileSystemTraceStore: new (args: { dir: string }) => unknown
  FileSystemFeedbackTrajectoryStore?: new (args: { dir: string }) => {
    save(trajectory: unknown): Promise<void>
    list(filter?: unknown): Promise<unknown[]>
  }
  TraceEmitter: new (store: unknown, args?: { runId?: string }) => TraceEmitterLike
  validateRunRecord: (record: unknown) => unknown
  callLlmJson?: <T = unknown>(req: unknown, opts?: unknown) => Promise<{ value: T; result: unknown }>
  createFeedbackTrajectory?: (input: unknown) => unknown
  runMultiShotOptimization?: <P = unknown>(config: unknown) => Promise<unknown>
  trialTraceFromMultiShotTrial?: (trial: unknown) => unknown
  analyzeOptimizationResult?: (opts: unknown) => Promise<unknown>
}

export interface TraceEmitterLike {
  startRun(input: unknown): Promise<void>
  tool(input: { name: string; toolName: string; args?: unknown }): Promise<{ end(input: unknown): Promise<void> }>
  recordArtifact(input: unknown): Promise<void>
  endRun(input: unknown): Promise<void>
}

export async function importAgentEval(): Promise<AgentEvalModule> {
  const explicit = process.env.AGENT_EVAL_IMPORT
  const candidates = [
    explicit,
    '@tangle-network/agent-eval',
    '/Users/drew/webb/agent-eval/dist/index.js',
  ].filter((value): value is string => Boolean(value))
  const failures: string[] = []
  for (const spec of candidates) {
    try {
      return await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec) as AgentEvalModule
    } catch (error) {
      failures.push(`${spec}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Unable to import @tangle-network/agent-eval. Tried:\n${failures.join('\n')}`)
}
