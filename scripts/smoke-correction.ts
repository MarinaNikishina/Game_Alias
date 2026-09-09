/**
 * Correction path: always capture both player tokens.
 */
const API = process.env.API_URL || 'http://localhost:3001'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}: ${data.error || res.statusText}`)
  return data
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

async function main() {
  const created = await req<{
    game: { id: string; publicCode: string; teams: { id: string }[] }
    adminToken: string
  }>('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCount: 2, capacities: [2, 2] }),
  })
  const admin = created.adminToken
  const gameId = created.game.id
  const code = created.game.publicCode

  const p1 = await req<{ playerId: string; playerToken: string }>(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'C1', teamId: created.game.teams[0].id }),
  })
  const p2 = await req<{ playerId: string; playerToken: string }>(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'C2', teamId: created.game.teams[1].id }),
  })

  await req(`/api/games/${gameId}/start`, { method: 'POST', headers: auth(admin) })
  const assigned = await req<{
    game: {
      currentRound: { id: string } | null
      turns: { status: string; playerId: string }[]
    }
  }>(`/api/games/${gameId}/next-turn`, { method: 'POST', headers: auth(admin) })

  const turn = assigned.game.turns.find((t) => t.status === 'ASSIGNED')!
  const token = turn.playerId === p1.playerId ? p1.playerToken : p2.playerToken
  const started = await req<{
    game: { currentRound: { id: string; currentExposure: { id: string } | null } | null }
  }>(`/api/rounds/${assigned.game.currentRound!.id}/start`, {
    method: 'POST',
    headers: auth(token),
  })
  const exposureId = started.game.currentRound!.currentExposure!.id
  await req(`/api/rounds/${started.game.currentRound!.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({ exposureId, status: 'SKIPPED', idempotencyKey: 'corr-1' }),
  })
  await req(`/api/games/${gameId}/finish`, { method: 'POST', headers: auth(admin) })
  const corrected = await req<{ game: { teams: { score: number }[] } }>(
    `/api/word-exposures/${exposureId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth(admin) },
      body: JSON.stringify({ status: 'GUESSED' }),
    },
  )
  if (!corrected.game.teams.some((t) => t.score >= 1)) throw new Error('Correction score failed')
  console.log(JSON.stringify({ ok: true, correction: true, scores: corrected.game.teams.map((t) => t.score) }))
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
