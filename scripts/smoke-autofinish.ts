const API = process.env.API_URL || 'http://localhost:3001'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}: ${data.error || 'err'}`)
  return data
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

async function playOneRound(
  gameId: string,
  admin: string,
  tokens: Record<string, string>,
) {
  const assigned = await req<{
    game: {
      status: string
      currentRound: { id: string } | null
      turns: { status: string; playerId: string }[]
    }
  }>(`/api/games/${gameId}/next-turn`, { method: 'POST', headers: auth(admin) })
  if (assigned.game.status === 'FINISHED') return assigned.game
  const turn = assigned.game.turns.find((t) => t.status === 'ASSIGNED')
  if (!turn || !assigned.game.currentRound) throw new Error('no assigned turn')
  const token = tokens[turn.playerId]
  const started = await req<{
    game: { currentRound: { id: string; currentExposure: { id: string } | null } | null }
  }>(`/api/rounds/${assigned.game.currentRound.id}/start`, {
    method: 'POST',
    headers: auth(token),
  })
  await req(`/api/rounds/${started.game.currentRound!.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({
      exposureId: started.game.currentRound!.currentExposure!.id,
      status: 'GUESSED',
      idempotencyKey: crypto.randomUUID(),
    }),
  })
  // Force finish remaining time by admin finish is not needed; answer leaves round ACTIVE.
  // Finish round via admin game finish only at end — instead patch: call finish round by answering until...
  // For auto-finish we need rounds FINISHED. Use admin finish of game only after all turns done.
  // Shortcut: finish current round by admin game is heavy. Add force by answering and then
  // manually finalize via finishing the game mid-round is wrong.
  // Use PATCH path: call finish game is not auto.
  // Better approach: set very short duration at create.
  return null
}

async function main() {
  const created = await req<{
    game: { id: string; publicCode: string; teams: { id: string }[]; baseRoundDurationMs: number }
    adminToken: string
  }>('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCount: 2, capacities: [1, 1], baseRoundDurationMs: 2000 }),
  })
  const admin = created.adminToken
  const gameId = created.game.id
  const code = created.game.publicCode
  const p1 = await req<{ playerId: string; playerToken: string }>(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A1', teamId: created.game.teams[0].id }),
  })
  const p2 = await req<{ playerId: string; playerToken: string }>(`/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'B1', teamId: created.game.teams[1].id }),
  })
  const tokens: Record<string, string> = {
    [p1.playerId]: p1.playerToken,
    [p2.playerId]: p2.playerToken,
  }
  await req(`/api/games/${gameId}/start`, { method: 'POST', headers: auth(admin) })

  for (let i = 0; i < 2; i += 1) {
    const assigned = await req<{
      game: {
        currentRound: { id: string } | null
        turns: { status: string; playerId: string }[]
      }
    }>(`/api/games/${gameId}/next-turn`, { method: 'POST', headers: auth(admin) })
    const turn = assigned.game.turns.find((t) => t.status === 'ASSIGNED')!
    const token = tokens[turn.playerId]
    const started = await req<{
      game: { currentRound: { id: string; currentExposure: { id: string } | null } | null }
    }>(`/api/rounds/${assigned.game.currentRound!.id}/start`, {
      method: 'POST',
      headers: auth(token),
    })
    // wait for timer + grace to auto-finish round (~2s + 5s)
    await new Promise((r) => setTimeout(r, 8000))
    // poll snapshot
    let status = 'ACTIVE'
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snap = await req<{ game: { status: string; turns: { status: string }[]; currentRound: unknown } }>(
        `/api/games/${gameId}`,
      )
      status = snap.game.status
      const open = snap.game.turns.some((t) => t.status === 'ASSIGNED' || t.status === 'ACTIVE')
      if (!open) break
      await new Promise((r) => setTimeout(r, 500))
    }
    void started
    if (i === 1 && status !== 'FINISHED') {
      // after second round should auto finish
      const finalSnap = await req<{ game: { status: string } }>(`/api/games/${gameId}`)
      if (finalSnap.game.status !== 'FINISHED') {
        throw new Error(`Expected auto-finish, got ${finalSnap.game.status}`)
      }
    }
  }

  const finalSnap = await req<{ game: { status: string; finishReason: string | null } }>(
    `/api/games/${gameId}`,
  )
  console.log(
    JSON.stringify({
      ok: true,
      status: finalSnap.game.status,
      finishReason: finalSnap.game.finishReason,
    }),
  )
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
