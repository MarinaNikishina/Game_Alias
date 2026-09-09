/**
 * Smoke reconnect pause/resume via HTTP presence is limited;
 * verifies restore-player-session after join.
 */
const API = process.env.API_URL || 'http://localhost:3001'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error}`)
  return data
}

async function main() {
  const created = await req<{
    game: { id: string; publicCode: string; teams: { id: string }[] }
    adminToken: string
  }>('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCount: 2, capacities: [2, 2] }),
  })
  const join = await req<{ playerId: string; playerToken: string; game: { id: string } }>(
    `/api/games/${created.game.publicCode}/join`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ReconnectMe', teamId: created.game.teams[0].id }),
    },
  )
  const restored = await req<{ playerId: string; game: { id: string } }>(
    `/api/games/${created.game.id}/restore-player-session`,
    { method: 'POST', headers: { Authorization: `Bearer ${join.playerToken}` } },
  )
  if (restored.playerId !== join.playerId) throw new Error('restore mismatch')
  console.log(JSON.stringify({ ok: true, restored: true }))
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
