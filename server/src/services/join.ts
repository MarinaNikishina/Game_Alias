import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { games, players, teams, turns } from '../db/schema.ts'
import { createToken, hashToken, HttpError, normalizePlayerName } from '../lib/utils.ts'
import { bumpGameVersion } from './game.ts'
import { buildGameSnapshot } from './snapshot.ts'

export async function joinGame(publicCode: string, name: string, teamId: string) {
  const normalizedName = normalizePlayerName(name)
  if (!normalizedName) throw new HttpError(400, 'Введите имя')
  if (normalizedName.length > 40) throw new HttpError(400, 'Имя слишком длинное')

  const playerToken = createToken()
  const tokenHash = hashToken(playerToken)

  const result = await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.publicCode, publicCode)).for('update')
    if (!game) throw new HttpError(404, 'Игра не найдена')
    if (game.status === 'FINISHED') throw new HttpError(409, 'Игра уже завершена')

    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId)).for('update')
    if (!team || team.gameId !== game.id) throw new HttpError(404, 'Команда не найдена')

    const [existingByName] = await tx
      .select()
      .from(players)
      .where(and(eq(players.gameId, game.id), eq(players.normalizedName, normalizedName)))
      .limit(1)

    if (existingByName) {
      if (existingByName.connectivityState === 'CONNECTED') {
        throw new HttpError(409, 'Игрок с таким именем уже в игре')
      }
      await tx
        .update(players)
        .set({
          sessionTokenHash: tokenHash,
          connectivityState: 'CONNECTED',
          lastSeenAt: new Date(),
        })
        .where(eq(players.id, existingByName.id))
      return { gameId: game.id, playerId: existingByName.id, restored: true as const }
    }

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(players)
      .where(eq(players.teamId, team.id))

    if (count >= team.capacity) {
      throw new HttpError(409, 'В этой команде больше нет мест. Выберите другую команду.', 'TEAM_FULL')
    }

    const [player] = await tx
      .insert(players)
      .values({
        gameId: game.id,
        teamId: team.id,
        name: name.trim().replace(/\s+/g, ' '),
        normalizedName,
        sessionTokenHash: tokenHash,
        connectivityState: 'CONNECTED',
        playState: 'WAITING',
      })
      .returning()

    if (game.status === 'ACTIVE') {
      await appendLateJoinTurn(tx, game.id, player.id, player.teamId)
    }

    return { gameId: game.id, playerId: player.id, restored: false as const }
  })

  await bumpGameVersion(result.gameId)
  const game = await buildGameSnapshot(result.gameId)
  return { game, playerId: result.playerId, playerToken }
}

async function appendLateJoinTurn(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  gameId: string,
  playerId: string,
  teamId: string,
) {
  const teamPending = await tx
    .select()
    .from(turns)
    .where(and(eq(turns.gameId, gameId), eq(turns.teamId, teamId), eq(turns.status, 'PENDING')))
    .orderBy(asc(turns.position))

  const allTurns = await tx
    .select()
    .from(turns)
    .where(eq(turns.gameId, gameId))
    .orderBy(asc(turns.position))

  let insertPosition: number
  if (teamPending.length > 0) {
    insertPosition = teamPending[teamPending.length - 1].position + 1
  } else {
    insertPosition = (allTurns[allTurns.length - 1]?.position ?? 0) + 1
  }

  const toShift = allTurns.filter((turn) => turn.position >= insertPosition)
  for (const turn of [...toShift].sort((a, b) => b.position - a.position)) {
    await tx
      .update(turns)
      .set({ position: turn.position + 1 })
      .where(eq(turns.id, turn.id))
  }

  await tx.insert(turns).values({
    gameId,
    teamId,
    playerId,
    position: insertPosition,
    status: 'PENDING',
  })
}

export async function restorePlayerSession(gameId: string, token: string) {
  const tokenHash = hashToken(token)
  const [player] = await db
    .select()
    .from(players)
    .where(and(eq(players.gameId, gameId), eq(players.sessionTokenHash, tokenHash)))
    .limit(1)

  if (!player) throw new HttpError(401, 'Сессия игрока не найдена')

  await db
    .update(players)
    .set({ connectivityState: 'CONNECTED', lastSeenAt: new Date() })
    .where(eq(players.id, player.id))

  return {
    playerId: player.id,
    game: await buildGameSnapshot(gameId),
  }
}

export async function markPlayerConnected(playerId: string, connected: boolean) {
  await db
    .update(players)
    .set({
      connectivityState: connected ? 'CONNECTED' : 'DISCONNECTED',
      lastSeenAt: new Date(),
    })
    .where(eq(players.id, playerId))
}
