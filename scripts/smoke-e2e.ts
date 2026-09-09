/**
 * Smoke e2e against local API. Does not print tokens.
 * Run: npx tsx scripts/smoke-e2e.ts
 */
const API = process.env.API_URL || 'http://localhost:3001'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}: ${data.error || res.statusText}`)
  return data
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function main() {
  const created = await req<{
    game: { id: string; publicCode: string; teams: { id: string; capacity: number }[] }
    adminToken: string
  }>('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCount: 2, capacities: [2, 2] }),
  })

  const gameId = created.game.id
  const code = created.game.publicCode
  const admin = created.adminToken
  const [teamA, teamB] = created.game.teams

  const p1 = await req<{ playerId: string; playerToken: string; game: { players: unknown[] } }>(
    `/api/games/${code}/join`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Аня', teamId: teamA.id }),
    },
  )
  const p2 = await req<{ playerId: string; playerToken: string }>(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Боря', teamId: teamB.id }),
  })

  // capacity race: fill team A second slot then expect conflict
  await req(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Вася', teamId: teamA.id }),
  })
  let capacityBlocked = false
  try {
    await req(`/api/games/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Галя', teamId: teamA.id }),
    })
  } catch {
    capacityBlocked = true
  }
  if (!capacityBlocked) throw new Error('Expected team capacity conflict')

  const started = await req<{ game: { status: string; turns: { id: string; status: string; playerId: string }[] } }>(
    `/api/games/${gameId}/start`,
    { method: 'POST', headers: auth(admin) },
  )
  if (started.game.status !== 'ACTIVE') throw new Error('Game not ACTIVE')
  if (started.game.turns.length < 3) throw new Error('Queue too short')

  const assigned = await req<{
    game: {
      currentTurnId: string | null
      currentRound: { id: string; status: string; playerId: string } | null
      turns: { id: string; status: string; playerId: string; teamId: string }[]
    }
  }>(`/api/games/${gameId}/next-turn`, { method: 'POST', headers: auth(admin) })

  const assignedTurn = assigned.game.turns.find((t) => t.status === 'ASSIGNED')
  if (!assignedTurn || !assigned.game.currentRound) throw new Error('Turn not assigned')

  // wrong player cannot start
  const otherToken = assignedTurn.playerId === p1.playerId ? p2.playerToken : p1.playerToken
  let blockedStart = false
  try {
    await req(`/api/rounds/${assigned.game.currentRound.id}/start`, {
      method: 'POST',
      headers: auth(otherToken),
    })
  } catch {
    blockedStart = true
  }
  if (!blockedStart) throw new Error('Expected start authorization failure')

  const ownerToken = assignedTurn.playerId === p1.playerId ? p1.playerToken : p2.playerToken
  const roundStarted = await req<{
    game: {
      currentRound: {
        id: string
        status: string
        currentExposure: { id: string; text: string; status: string } | null
      } | null
    }
  }>(`/api/rounds/${assigned.game.currentRound.id}/start`, {
    method: 'POST',
    headers: auth(ownerToken),
  })
  if (roundStarted.game.currentRound?.status !== 'ACTIVE') throw new Error('Round not ACTIVE')
  const exposureId = roundStarted.game.currentRound.currentExposure?.id
  if (!exposureId) throw new Error('No exposure')

  const answered = await req<{
    game: {
      currentRound: { currentExposure: { id: string } | null; exposures: { status: string }[] } | null
      teams: { score: number }[]
    }
  }>(`/api/rounds/${roundStarted.game.currentRound.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(ownerToken) },
    body: JSON.stringify({ exposureId, status: 'GUESSED', idempotencyKey: 'k1' }),
  })
  if (!answered.game.teams.some((t) => t.score >= 1)) throw new Error('Score not updated')

  // idempotent re-answer same exposure
  await req(`/api/rounds/${roundStarted.game.currentRound.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(ownerToken) },
    body: JSON.stringify({ exposureId, status: 'GUESSED', idempotencyKey: 'k1' }),
  })

  console.log(
    JSON.stringify({
      ok: true,
      publicCode: code,
      queueSize: started.game.turns.length,
      capacityBlocked,
      blockedStart,
      score: answered.game.teams.map((t) => t.score),
    }),
  )
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
