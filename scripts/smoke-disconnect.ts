const API = process.env.API_URL || 'http://localhost:3001'
const WS_URL = API.replace(/^http/, 'ws') + '/ws'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error}`)
  return data
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

function waitSnapshot(ws: WebSocket, pred: (game: any) => boolean, ms = 20000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), ms)
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data))
      if (msg.type === 'game.snapshot' && pred(msg.game)) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(msg.game)
      }
    }
    ws.addEventListener('message', onMessage)
  })
}

async function setupUntilPlayerFirst() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const created = await req<{
      game: { id: string; publicCode: string; teams: { id: string }[] }
      adminToken: string
    }>('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamCount: 2, capacities: [1, 1], baseRoundDurationMs: 120000 }),
    })
    const hero = await req<{ playerId: string; playerToken: string }>(
      `/api/games/${created.game.publicCode}/join`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Hero${attempt}`, teamId: created.game.teams[0].id }),
      },
    )
    await req(`/api/games/${created.game.publicCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Other${attempt}`, teamId: created.game.teams[1].id }),
    })
    await req(`/api/games/${created.game.id}/start`, {
      method: 'POST',
      headers: auth(created.adminToken),
    })
    const assigned = await req<{
      game: {
        currentRound: { id: string; playerId: string } | null
        turns: { status: string; playerId: string }[]
      }
    }>(`/api/games/${created.game.id}/next-turn`, {
      method: 'POST',
      headers: auth(created.adminToken),
    })
    const turn = assigned.game.turns.find((t) => t.status === 'ASSIGNED')!
    if (turn.playerId === hero.playerId) {
      return {
        gameId: created.game.id,
        roundId: assigned.game.currentRound!.id,
        token: hero.playerToken,
      }
    }
    await req(`/api/games/${created.game.id}/finish`, {
      method: 'POST',
      headers: auth(created.adminToken),
    })
  }
  throw new Error('Could not get hero first in queue')
}

async function main() {
  const { gameId, roundId, token } = await setupUntilPlayerFirst()

  const ws = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true })
  })
  ws.send(JSON.stringify({ type: 'subscribe', gameId, role: 'PLAYER', token }))
  await waitSnapshot(ws, (g) => g.id === gameId)

  await req(`/api/rounds/${roundId}/start`, { method: 'POST', headers: auth(token) })
  ws.close()

  let reconnecting = false
  for (let i = 0; i < 40; i += 1) {
    const snap = await req<{ game: { currentRound: { status: string } | null } }>(
      `/api/games/${gameId}`,
    )
    if (snap.game.currentRound?.status === 'RECONNECTING') {
      reconnecting = true
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!reconnecting) throw new Error('Expected RECONNECTING')

  await req(`/api/games/${gameId}/restore-player-session`, {
    method: 'POST',
    headers: auth(token),
  })
  const ws2 = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws2.addEventListener('open', () => resolve(), { once: true })
    ws2.addEventListener('error', () => reject(new Error('ws2 open failed')), { once: true })
  })
  ws2.send(JSON.stringify({ type: 'subscribe', gameId, role: 'PLAYER', token }))
  const resumed = await waitSnapshot(
    ws2,
    (g) => g.currentRound && ['ACTIVE', 'FINAL_WORD_GRACE'].includes(g.currentRound.status),
  )
  ws2.close()

  console.log(
    JSON.stringify({ ok: true, reconnecting: true, resumedStatus: resumed.currentRound.status }),
  )
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
