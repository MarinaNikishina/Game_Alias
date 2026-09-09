import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { GameSnapshot, WsClientMessage } from '../../../shared/src/index.ts'
import { hashToken } from '../lib/utils.ts'
import { db } from '../db/client.ts'
import { adminSessions, players } from '../db/schema.ts'
import { and, eq } from 'drizzle-orm'
import { buildGameSnapshot } from '../services/snapshot.ts'
import {
  findActiveRoundForPlayer,
  pauseRoundForDisconnect,
  resumeRoundAfterReconnect,
} from '../services/round.ts'
import { markPlayerConnected } from '../services/join.ts'

interface ClientState {
  socket: WebSocket
  gameId: string
  role: 'ADMIN' | 'PLAYER'
  playerId?: string
}

const clients = new Set<ClientState>()

export function broadcastGame(gameId: string, game?: GameSnapshot) {
  void (async () => {
    const snapshot = game ?? (await buildGameSnapshot(gameId))
    const payload = JSON.stringify({ type: 'game.snapshot', game: snapshot })
    for (const client of clients) {
      if (client.gameId === gameId && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload)
      }
    }
  })()
}

export function attachWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (socket) => {
    let state: ClientState | null = null

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw)) as WsClientMessage
        if (message.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', serverNow: new Date().toISOString() }))
          return
        }

        if (message.type === 'subscribe') {
          const tokenHash = hashToken(message.token)
          if (message.role === 'ADMIN') {
            const [session] = await db
              .select()
              .from(adminSessions)
              .where(
                and(
                  eq(adminSessions.gameId, message.gameId),
                  eq(adminSessions.secretTokenHash, tokenHash),
                ),
              )
              .limit(1)
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', message: 'Нет доступа администратора' }))
              return
            }
            state = { socket, gameId: message.gameId, role: 'ADMIN' }
          } else {
            const [player] = await db
              .select()
              .from(players)
              .where(
                and(eq(players.gameId, message.gameId), eq(players.sessionTokenHash, tokenHash)),
              )
              .limit(1)
            if (!player) {
              socket.send(JSON.stringify({ type: 'error', message: 'Нет доступа игрока' }))
              return
            }
            state = {
              socket,
              gameId: message.gameId,
              role: 'PLAYER',
              playerId: player.id,
            }
            await markPlayerConnected(player.id, true)
            const activeRound = await findActiveRoundForPlayer(player.id)
            if (activeRound?.status === 'RECONNECTING') {
              await resumeRoundAfterReconnect(activeRound.id)
            }
          }

          clients.add(state)
          const snapshot = await buildGameSnapshot(message.gameId)
          socket.send(JSON.stringify({ type: 'game.snapshot', game: snapshot }))
          if (state.role === 'PLAYER') broadcastGame(message.gameId)
        }
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'WS error',
          }),
        )
      }
    })

    socket.on('close', async () => {
      if (!state) return
      clients.delete(state)
      if (state.role === 'PLAYER' && state.playerId) {
        const stillConnected = [...clients].some(
          (client) => client.playerId === state!.playerId && client.socket.readyState === WebSocket.OPEN,
        )
        if (!stillConnected) {
          await markPlayerConnected(state.playerId, false)
          const activeRound = await findActiveRoundForPlayer(state.playerId)
          if (
            activeRound &&
            (activeRound.status === 'ACTIVE' || activeRound.status === 'FINAL_WORD_GRACE')
          ) {
            await pauseRoundForDisconnect(activeRound.id)
            broadcastGame(state.gameId)
          } else {
            broadcastGame(state.gameId)
          }
        }
      }
    })
  })
}
