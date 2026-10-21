import { block, clip } from './block'
import { optionValue, program, words } from './shell'

export type EnvIo = {
  vpnUp: () => Promise<boolean>
  kubeContext: () => Promise<string | undefined>
  ssoAgeMs: () => Promise<number | undefined>
}

const PROD = /prod/i

const SSO_STALE_MS = 8 * 3_600_000

const KUBECTL_VALUE_FLAGS = new Set([
  '--context', '--cluster', '--kubeconfig', '--namespace', '-n', '--user', '-s', '--server', '-o', '--output',
  '-l', '--selector', '-c', '--container', '-f', '--filename', '--token', '--as', '--request-timeout', '-p',
  '--sort-by', '--field-selector', '--tail', '--since', '--template',
])

const KUBECTL_LOCAL = new Set(['config', 'version', 'help', 'completion', 'plugin', 'kustomize'])

const AWS_VALUE_FLAGS = new Set([
  '--profile', '--region', '--output', '--query', '--endpoint-url', '--cli-read-timeout', '--cli-connect-timeout', '--color',
])

const AWS_LOCAL = new Set(['sso', 'configure', 'help'])

function prodBlock(command: string, why: string): string {
  return block({
    rule: 'prod-access',
    category: 'use-instead',
    problem: `this would reach production (${why}); direct kubectl/AWS access to production is blocked.`,
    where: clip(command),
    fix: 'for production logs, use your read-only logs tool instead. Do not retry another way.',
    ask: 'for anything the logs tool cannot show.',
  })
}

function vpnBlock(command: string): string {
  return block({
    rule: 'vpn-down',
    category: 'env-setup',
    problem: 'the VPN is down, so the cluster is unreachable.',
    where: clip(command),
    fix: 'do not start the VPN yourself (it needs sudo); retry once the user says it is up.',
    ask: 'to connect the VPN in their own terminal.',
  })
}

function subcommand(args: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (!arg.startsWith('-')) return arg
  }
  return undefined
}

function assigned(tokens: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  const found = tokens.find(token => token.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}

async function ssoVerdict(command: string, io: EnvIo): Promise<string | undefined> {
  const age = await io.ssoAgeMs()
  if (age !== undefined && age <= SSO_STALE_MS) return undefined
  return block({
    rule: 'aws-sso',
    category: 'env-setup',
    problem: age === undefined ? 'no AWS SSO session found.' : `the AWS SSO session looks expired (last refreshed ${Math.round(age / 3_600_000)}h ago).`,
    where: clip(command),
    fix: 'retry once the user has logged in.',
    ask: 'to run `! aws sso login`.',
  })
}

export async function envVerdict(segments: readonly string[][], io: EnvIo): Promise<string | undefined> {
  let exportedProfile: string | undefined
  for (const tokens of segments) {
    if (tokens[0] === 'export') {
      exportedProfile = assigned(tokens.slice(1), 'AWS_PROFILE') ?? exportedProfile
      continue
    }
    const parts = words(tokens)
    const name = program(parts[0])
    if (name !== 'kubectl' && name !== 'aws') continue
    const args = parts.slice(1)
    const command = tokens.join(' ')
    const profile = assigned(tokens.slice(0, tokens.length - parts.length), 'AWS_PROFILE') ?? exportedProfile
    if (profile !== undefined && PROD.test(profile)) return prodBlock(command, `AWS profile ${profile}`)
    if (name === 'kubectl') {
      if (KUBECTL_LOCAL.has(subcommand(args, KUBECTL_VALUE_FLAGS) ?? 'help')) continue
      const context = optionValue(args, ['--context', '--cluster'])
      if (context !== undefined && PROD.test(context)) return prodBlock(command, `context ${context}`)
      if (context === undefined) {
        const current = await io.kubeContext()
        if (current !== undefined && PROD.test(current)) return prodBlock(command, `current kube context ${current}`)
      }
      if (!(await io.vpnUp())) return vpnBlock(command)
      const sso = await ssoVerdict(command, io)
      if (sso) return sso
      continue
    }
    const service = subcommand(args, AWS_VALUE_FLAGS) ?? 'help'
    if (args.includes('--version') || AWS_LOCAL.has(service) || args.includes('get-caller-identity')) continue
    const named = optionValue(args, ['--profile'])
    if (named !== undefined && PROD.test(named)) return prodBlock(command, `AWS profile ${named}`)
    const cluster = service === 'eks' ? optionValue(args, ['--name', '--cluster-name']) : undefined
    if (cluster !== undefined && PROD.test(cluster)) return prodBlock(command, `cluster ${cluster}`)
    if (args.some(arg => /arn:aws:eks:[^\s]*:cluster\/[^\s]*prod/i.test(arg))) return prodBlock(command, 'a prod EKS cluster')
    const sso = await ssoVerdict(command, io)
    if (sso) return sso
  }
  return undefined
}
