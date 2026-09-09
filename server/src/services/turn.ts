import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { games, players, rounds, turns } from '../db/schema.ts'
import { HttpError } from '../lib/utils.ts'
import { assertAdmin, bumpGameVersion } from './game.ts'
import { buildGameSnapshot } from './snapshot.ts'
import { maybeAutoFinishGame } from './finish.ts'

export async function assignNextTurn(gameId: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)

  await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('update')
    if (!game) throw new HttpError(404, 'Игра не найдена')
    if (game.status !== 'ACTIVE') throw new HttpError(409, 'Игра не активна')

    const activeOrAssigned = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.gameId, gameId), inArray(turns.status, ['ASSIGNED', 'ACTIVE'])))
      .limit(1)

    if (activeOrAssigned.length > 0) {
      throw new HttpError(409, 'Сначала завершите текущий ход')
    }

    const [next] = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.gameId, gameId), eq(turns.status, 'PENDING')))
      .orderBy(asc(turns.position))
      .limit(1)
      .for('update')

    if (!next) throw new HttpError(409, 'Нет ожидающих ходов')

    const now = new Date()
    await tx
      .update(turns)
      .set({ status: 'ASSIGNED', assignedAt: now })
      .where(eq(turns.id, next.id))

    await tx
      .update(players)
      .set({ playState: 'ASSIGNED' })
      .where(eq(players.id, next.playerId))

    await tx.insert(rounds).values({
      turnId: next.id,
      playerId: next.playerId,
      teamId: next.teamId,
      gameId,
      status: 'PENDING',
      baseDurationMs: game.baseRoundDurationMs,
      bonusDurationMs: (
        await tx.select().from(players).where(eq(players.id, next.playerId)).limit(1)
      )[0]?.bonusTimeMs ?? 0,
    })

    await tx
      .update(games)
      .set({ currentTurnId: next.id, version: game.version + 1 })
      .where(eq(games.id, gameId))
  })

  return buildGameSnapshot(gameId)
}

export async function deferTurn(gameId: string, turnId: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)

  await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('update')
    if (!game) throw new HttpError(404, 'Игра не найдена')
    if (game.status !== 'ACTIVE') throw new HttpError(409, 'Игра не активна')

    const [current] = await tx.select().from(turns).where(eq(turns.id, turnId)).for('update')
    if (!current || current.gameId !== gameId) throw new HttpError(404, 'Ход не найден')
    if (current.status !== 'ASSIGNED') {
      throw new HttpError(409, 'Отложить можно только назначенный, но не начатый ход')
    }

    const [sameTeamNext] = await tx
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.gameId, gameId),
          eq(turns.teamId, current.teamId),
          eq(turns.status, 'PENDING'),
          ne(turns.id, current.id),
        ),
      )
      .orderBy(asc(turns.position))
      .limit(1)
      .for('update')

    if (!sameTeamNext) {
      throw new HttpError(409, 'В команде нет другого игрока, которому можно отдать ход')
    }

    await tx.delete(rounds).where(and(eq(rounds.turnId, current.id), eq(rounds.status, 'PENDING')))

    const teamPending = await tx
      .select()
      .from(turns)
      .where(and(eq(turns.gameId, gameId), eq(turns.teamId, current.teamId), eq(turns.status, 'PENDING')))
      .orderBy(asc(turns.position))

    const allTurns = await tx
      .select()
      .from(turns)
      .where(eq(turns.gameId, gameId))
      .orderBy(asc(turns.position))

    const newPosition =
      teamPending.length > 0
        ? teamPending[teamPending.length - 1].position + 1
        : allTurns[allTurns.length - 1].position + 1

    // Move current to end of team pending: set PENDING and shift positions.
    await tx.update(players).set({ playState: 'WAITING' }).where(eq(players.id, current.playerId))

    const toShift = allTurns.filter((turn) => turn.position >= newPosition && turn.id !== current.id)
    for (const turn of [...toShift].sort((a, b) => b.position - a.position)) {
      await tx.update(turns).set({ position: turn.position + 1 }).where(eq(turns.id, turn.id))
    }

    await tx
      .update(turns)
      .set({
        status: 'PENDING',
        assignedAt: null,
        position: newPosition,
      })
      .where(eq(turns.id, current.id))

    // Assign the next same-team pending (sameTeamNext may have shifted)
    const [replacement] = await tx
      .select()
      .from(turns)
      .where(eq(turns.id, sameTeamNext.id))
      .limit(1)

    const now = new Date()
    await tx
      .update(turns)
      .set({ status: 'ASSIGNED', assignedAt: now })
      .where(eq(turns.id, replacement.id))

    await tx.update(players).set({ playState: 'ASSIGNED' }).where(eq(players.id, replacement.playerId))

    const [player] = await tx.select().from(players).where(eq(players.id, replacement.playerId)).limit(1)

    await tx.insert(rounds).values({
      turnId: replacement.id,
      playerId: replacement.playerId,
      teamId: replacement.teamId,
      gameId,
      status: 'PENDING',
      baseDurationMs: game.baseRoundDurationMs,
      bonusDurationMs: player?.bonusTimeMs ?? 0,
    })

    await tx
      .update(games)
      .set({ currentTurnId: replacement.id, version: game.version + 1 })
      .where(eq(games.id, gameId))
  })

  return buildGameSnapshot(gameId)
}

export async function clearCurrentTurnIfFinished(gameId: string, turnId: string) {
  await db
    .update(games)
    .set({ currentTurnId: null, version: sql`${games.version} + 1` })
    .where(and(eq(games.id, gameId), eq(games.currentTurnId, turnId)))
  await maybeAutoFinishGame(gameId)
  await bumpGameVersion(gameId)
}
