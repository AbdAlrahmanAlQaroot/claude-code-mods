import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

const AGENT_TTL_MS = 3 * 60 * 60 * 1000
const KEEPER = 'caffeinate -i -w $$ & i=0; while [ "$i" -lt 2880 ]; do echo .; sleep 15; i=$((i+1)); done'

type Keeper = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const awake = {
  isTurnRunning: false,
  agents: new Map<string, number>(),
  keeper: undefined as Keeper | undefined,
}

const drain = async (started: Keeper) => {
  try {
    for await (const _ping of started) if (awake.keeper !== started) break
  } catch {}
  if (awake.keeper === started) awake.keeper = undefined
}

const hold = ($: EngineInterface) => {
  if (awake.keeper !== undefined) return
  const started = $.process.spawn({ argv: ['/bin/sh', '-c', KEEPER] })
  awake.keeper = started
  void drain(started)
}

const release = () => {
  const held = awake.keeper
  awake.keeper = undefined
  held?.return({ code: null, signal: null }).catch(() => {})
}

const sync = async ($: EngineInterface) => {
  const now = await $.clock.now()
  for (const [id, since] of awake.agents) if (now - since > AGENT_TTL_MS) awake.agents.delete(id)
  if (awake.isTurnRunning || awake.agents.size > 0) hold($)
  else release()
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    awake.isTurnRunning = true
    await sync($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) awake.isTurnRunning = false
    else awake.agents.delete(e.agentId)
    await sync($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (e.background && spawned.agentId !== undefined) {
      awake.agents.set(spawned.agentId, await $.clock.now())
      await sync($)
    }
    return spawned
  })

  on('session.end', async ($, e, next) => {
    awake.isTurnRunning = false
    awake.agents.clear()
    release()
    return next(e)
  })
}
