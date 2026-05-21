import { spawnSync } from 'node:child_process'
import { repoRoot } from './repo.js'

export interface CommandResult {
  stdout: string
  stderr: string
  status: number
}

export function run(command: string, args: string[], cwd = repoRoot): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  }
}

export function runShell(command: string, cwd = repoRoot, env: NodeJS.ProcessEnv = {}): CommandResult {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  }
}
