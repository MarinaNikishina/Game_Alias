import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { HttpError } from '../lib/utils.ts'
import {
  createGame,
  getGameById,
  getGameByPublicCode,
  listHistory,
  renameTeam,
  startGame,
} from '../services/game.ts'
import { joinGame, restorePlayerSession } from '../services/join.ts'
import { assignNextTurn, deferTurn } from '../services/turn.ts'
import { answerWord, startRound } from '../services/round.ts'
import {
  correctExposure,
  finishGameByAdmin,
  replayGame,
} from '../services/finish.ts'
import { getFinishedRoundExposures } from '../services/snapshot.ts'
import { broadcastGame } from '../ws/hub.ts'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { rounds } from '../db/schema.ts'

const createGameSchema = z.object({
  teamCount: z.union([z.literal(2), z.literal(3)]),
  capacities: z.array(z.number().int().min(1).max(20)).min(2).max(3),
  teamNames: z.array(z.string()).optional(),
  baseRoundDurationMs: z.number().int().positive().optional(),
})

function getBearer(header: string | undefined) {
  if (!header) return null
  const [type, token] = header.split(' ')
  if (type?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

export function createApp() {
  const app = new Hono()
  app.use('*', cors())

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.post('/api/games', async (c) => {
    const body = createGameSchema.parse(await c.req.json())
    const result = await createGame(body)
    return c.json(result, 201)
  })

  app.get('/api/games/by-code/:publicCode', async (c) => {
    const game = await getGameByPublicCode(c.req.param('publicCode'))
    return c.json({ game })
  })

  app.get('/api/games/:gameId', async (c) => {
    const game = await getGameById(c.req.param('gameId'))
    return c.json({ game })
  })

  app.post('/api/games/:gameId/start', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const game = await startGame(c.req.param('gameId'), token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/games/:gameId/next-turn', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const game = await assignNextTurn(c.req.param('gameId'), token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/games/:gameId/finish', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const game = await finishGameByAdmin(c.req.param('gameId'), token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/games/:gameId/replay', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const result = await replayGame(c.req.param('gameId'), token)
    return c.json(result, 201)
  })

  app.patch('/api/games/:gameId/teams/:teamId', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const body = z.object({ name: z.string().min(1) }).parse(await c.req.json())
    const game = await renameTeam(c.req.param('gameId'), c.req.param('teamId'), body.name, token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/games/:publicCode/join', async (c) => {
    const body = z
      .object({
        name: z.string().min(1),
        teamId: z.string().uuid(),
      })
      .parse(await c.req.json())
    const result = await joinGame(c.req.param('publicCode'), body.name, body.teamId)
    broadcastGame(result.game.id, result.game)
    return c.json(result, 201)
  })

  app.post('/api/games/:gameId/restore-player-session', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен игрока')
    const result = await restorePlayerSession(c.req.param('gameId'), token)
    broadcastGame(result.game.id, result.game)
    return c.json(result)
  })

  app.post('/api/games/:gameId/turns/:turnId/defer', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const game = await deferTurn(c.req.param('gameId'), c.req.param('turnId'), token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/rounds/:roundId/start', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен игрока')
    const game = await startRound(c.req.param('roundId'), token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.post('/api/rounds/:roundId/answer', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен игрока')
    const body = z
      .object({
        exposureId: z.string().uuid(),
        status: z.enum(['GUESSED', 'SKIPPED']),
        idempotencyKey: z.string().optional(),
      })
      .parse(await c.req.json())
    const game = await answerWord(
      c.req.param('roundId'),
      token,
      body.exposureId,
      body.status,
      body.idempotencyKey,
    )
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.patch('/api/word-exposures/:exposureId', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const body = z.object({ status: z.enum(['GUESSED', 'SKIPPED']) }).parse(await c.req.json())
    const game = await correctExposure(c.req.param('exposureId'), body.status, token)
    broadcastGame(game.id, game)
    return c.json({ game })
  })

  app.get('/api/admin/games/history', async (c) => {
    const history = await listHistory()
    return c.json({ history })
  })

  app.get('/api/admin/games/:gameId/player/:playerId/exposures', async (c) => {
    const token = getBearer(c.req.header('authorization'))
    if (!token) throw new HttpError(401, 'Нужен токен администратора')
    const { assertAdmin } = await import('../services/game.ts')
    await assertAdmin(c.req.param('gameId'), token)

    const finishedRounds = await db
      .select()
      .from(rounds)
      .where(
        and(
          eq(rounds.gameId, c.req.param('gameId')),
          eq(rounds.playerId, c.req.param('playerId')),
          eq(rounds.status, 'FINISHED'),
        ),
      )

    const exposures = []
    for (const round of finishedRounds) {
      exposures.push(...(await getFinishedRoundExposures(round.id)))
    }
    return c.json({ exposures })
  })

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400)
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: 'Некорректные данные', details: err.issues }, 400)
    }
    console.error(err)
    return c.json({ error: 'Внутренняя ошибка сервера' }, 500)
  })

  return app
}
