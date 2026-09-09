import type { GameSnapshot, HistoryRow } from '../shared/src/index.ts'

const jsonHeaders = { 'Content-Type': 'application/json' }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((data as { error?: string }).error || 'Ошибка запроса')
  }
  return data as T
}

export const api = {
  createGame(body: {
    teamCount: 2 | 3
    capacities: number[]
    teamNames?: string[]
  }) {
    return request<{ game: GameSnapshot; adminToken: string }>('/api/games', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
  },
  getGame(gameId: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}`)
  },
  getGameByCode(publicCode: string) {
    return request<{ game: GameSnapshot }>(`/api/games/by-code/${publicCode}`)
  },
  history() {
    return request<{ history: HistoryRow[] }>('/api/admin/games/history')
  },
  startGame(gameId: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  nextTurn(gameId: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}/next-turn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  deferTurn(gameId: string, turnId: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}/turns/${turnId}/defer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  finishGame(gameId: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}/finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  replayGame(gameId: string, token: string) {
    return request<{ game: GameSnapshot; adminToken: string }>(`/api/games/${gameId}/replay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  renameTeam(gameId: string, teamId: string, name: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/games/${gameId}/teams/${teamId}`, {
      method: 'PATCH',
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    })
  },
  join(publicCode: string, name: string, teamId: string) {
    return request<{ game: GameSnapshot; playerId: string; playerToken: string }>(
      `/api/games/${publicCode}/join`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name, teamId }),
      },
    )
  },
  restorePlayer(gameId: string, token: string) {
    return request<{ game: GameSnapshot; playerId: string }>(
      `/api/games/${gameId}/restore-player-session`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
    )
  },
  startRound(roundId: string, token: string) {
    return request<{ game: GameSnapshot }>(`/api/rounds/${roundId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  },
  answer(roundId: string, token: string, exposureId: string, status: 'GUESSED' | 'SKIPPED') {
    return request<{ game: GameSnapshot }>(`/api/rounds/${roundId}/answer`, {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        exposureId,
        status,
        idempotencyKey: crypto.randomUUID(),
      }),
    })
  },
  correctExposure(exposureId: string, status: 'GUESSED' | 'SKIPPED', token: string) {
    return request<{ game: GameSnapshot }>(`/api/word-exposures/${exposureId}`, {
      method: 'PATCH',
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    })
  },
  playerExposures(gameId: string, playerId: string, token: string) {
    return request<{
      exposures: Array<{
        id: string
        text: string
        status: 'PENDING' | 'GUESSED' | 'SKIPPED'
      }>
    }>(`/api/admin/games/${gameId}/player/${playerId}/exposures`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  },
}

export function adminTokenKey(gameId: string) {
  return `alias.admin.${gameId}`
}

export function playerSessionKey(gameId: string) {
  return `alias.player.${gameId}`
}

export function connectGameSocket(
  gameId: string,
  role: 'ADMIN' | 'PLAYER',
  token: string,
  onGame: (game: GameSnapshot) => void,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', gameId, role, token }))
  })

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data)) as
      | { type: 'game.snapshot'; game: GameSnapshot }
      | { type: 'error'; message: string }
      | { type: 'pong'; serverNow: string }
    if (data.type === 'game.snapshot') onGame(data.game)
  })

  const ping = window.setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
  }, 15000)

  return () => {
    window.clearInterval(ping)
    ws.close()
  }
}
