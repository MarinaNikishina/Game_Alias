import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { games, players, rounds, turns, wordExposures } from '../db/schema.ts'
import { HttpError } from '../lib/utils.ts'
import { assertAdmin, bumpGameVersion } from './game.ts'
import { buildGameSnapshot } from './snapshot.ts'

export async function maybeAutoFinishGame(gameId: string) {
  await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('update')
    if (!game || game.status !== 'ACTIVE') return

    const unfinishedPlayers = await tx
      .select()
      .from(players)
      .where(and(eq(players.gameId, gameId), ne(players.playState, 'PLAYED')))

    const openTurns = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.gameId, gameId), inArray(turns.status, ['ASSIGNED', 'ACTIVE', 'PENDING'])))

    if (unfinishedPlayers.length === 0 && openTurns.length === 0) {
      await tx
        .update(games)
        .set({
          status: 'FINISHED',
          finishedAt: new Date(),
          finishReason: 'AUTO',
          currentTurnId: null,
          version: game.version + 1,
        })
        .where(eq(games.id, gameId))
    }
  })
}

export async function finishGameByAdmin(gameId: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)

  await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('update')
    if (!game) throw new HttpError(404, 'Игра не найдена')
    if (game.status === 'FINISHED') return
    if (game.status !== 'ACTIVE' && game.status !== 'LOBBY') {
      throw new HttpError(409, 'Игру нельзя завершить в этом состоянии')
    }

    if (game.currentTurnId) {
      const [round] = await tx
        .select()
        .from(rounds)
        .where(
          and(
            eq(rounds.turnId, game.currentTurnId),
            sql`${rounds.status} <> 'FINISHED'`,
          ),
        )
        .for('update')

      if (round) {
        const [pending] = await tx
          .select()
          .from(wordExposures)
          .where(and(eq(wordExposures.roundId, round.id), eq(wordExposures.status, 'PENDING')))
          .limit(1)
          .for('update')

        if (pending) {
          await tx
            .update(wordExposures)
            .set({ status: 'SKIPPED', answeredAt: new Date(), originalStatus: 'SKIPPED' })
            .where(eq(wordExposures.id, pending.id))
        }

        const now = new Date()
        await tx
          .update(rounds)
          .set({
            status: 'FINISHED',
            finishedAt: now,
            finishReason: 'ADMIN_GAME_FINISH',
            phaseEndsAt: null,
            disconnectDeadlineAt: null,
          })
          .where(eq(rounds.id, round.id))

        await tx
          .update(turns)
          .set({ status: 'FINISHED', finishedAt: now })
          .where(eq(turns.id, round.turnId))

        await tx.update(players).set({ playState: 'PLAYED' }).where(eq(players.id, round.playerId))
      }
    }

    await tx
      .update(games)
      .set({
        status: 'FINISHED',
        finishedAt: new Date(),
        finishReason: 'ADMIN',
        currentTurnId: null,
        version: game.version + 1,
      })
      .where(eq(games.id, gameId))
  })

  return buildGameSnapshot(gameId)
}

export async function distributeBonusTime(gameId: string, teamId: string, unusedMs: number) {
  if (unusedMs <= 0) return

  await db.transaction(async (tx) => {
    const eligible = await tx
      .select()
      .from(players)
      .where(
        and(
          eq(players.gameId, gameId),
          eq(players.teamId, teamId),
          ne(players.playState, 'PLAYED'),
        ),
      )

    if (eligible.length === 0) return

    const base = Math.floor(unusedMs / eligible.length)
    let remainder = unusedMs - base * eligible.length

    for (const player of eligible) {
      const extra = remainder > 0 ? 1 : 0
      if (remainder > 0) remainder -= 1
      await tx
        .update(players)
        .set({ bonusTimeMs: player.bonusTimeMs + base + extra })
        .where(eq(players.id, player.id))
    }
  })

  await bumpGameVersion(gameId)
}

export async function correctExposure(
  exposureId: string,
  status: 'GUESSED' | 'SKIPPED',
  adminToken: string,
) {
  const [exposure] = await db
    .select()
    .from(wordExposures)
    .where(eq(wordExposures.id, exposureId))
    .limit(1)
  if (!exposure) throw new HttpError(404, 'Слово не найдено')

  await assertAdmin(exposure.gameId, adminToken)

  const [round] = await db.select().from(rounds).where(eq(rounds.id, exposure.roundId)).limit(1)
  if (!round || round.status !== 'FINISHED') {
    throw new HttpError(409, 'Править можно только после завершения раунда')
  }

  await db
    .update(wordExposures)
    .set({
      status,
      correctedAt: new Date(),
      correctedByAdmin: true,
      originalStatus: exposure.originalStatus ?? exposure.status,
    })
    .where(eq(wordExposures.id, exposureId))

  await bumpGameVersion(exposure.gameId)
  return buildGameSnapshot(exposure.gameId)
}

export async function replayGame(gameId: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)
  const snapshot = await buildGameSnapshot(gameId)
  if (snapshot.status !== 'FINISHED') {
    throw new HttpError(409, 'Повторить можно только завершённую игру')
  }

  const { createGame } = await import('./game.ts')
  return createGame({
    teamCount: snapshot.teams.length as 2 | 3,
    capacities: snapshot.teams.map((team) => team.capacity),
    teamNames: snapshot.teams.map((team) => team.name),
    baseRoundDurationMs: snapshot.baseRoundDurationMs,
  })
}
