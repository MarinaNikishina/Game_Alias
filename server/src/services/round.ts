import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { games, players, rounds, turns, wordExposures } from '../db/schema.ts'
import { hashToken, HttpError } from '../lib/utils.ts'
import { drawNextWord } from './deck.ts'
import { bumpGameVersion } from './game.ts'
import { distributeBonusTime, maybeAutoFinishGame } from './finish.ts'
import { buildGameSnapshot } from './snapshot.ts'

async function assertPlayerOwnsRound(roundId: string, playerToken: string) {
  const tokenHash = hashToken(playerToken)
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1)
  if (!round) throw new HttpError(404, 'Раунд не найден')

  const [player] = await db
    .select()
    .from(players)
    .where(and(eq(players.id, round.playerId), eq(players.sessionTokenHash, tokenHash)))
    .limit(1)

  if (!player) throw new HttpError(401, 'Нет доступа к этому раунду')
  return { round, player }
}

export async function startRound(roundId: string, playerToken: string) {
  const { round, player } = await assertPlayerOwnsRound(roundId, playerToken)

  await db.transaction(async (tx) => {
    const [freshRound] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!freshRound) throw new HttpError(404, 'Раунд не найден')
    if (freshRound.status !== 'PENDING') throw new HttpError(409, 'Раунд уже начат')

    const [turn] = await tx.select().from(turns).where(eq(turns.id, freshRound.turnId)).for('update')
    if (!turn || turn.status !== 'ASSIGNED') throw new HttpError(409, 'Ход не назначен')

    const now = new Date()
    const duration = freshRound.baseDurationMs + freshRound.bonusDurationMs
    const phaseEndsAt = new Date(now.getTime() + duration)

    await tx
      .update(rounds)
      .set({
        status: 'ACTIVE',
        startedAt: now,
        phaseEndsAt,
      })
      .where(eq(rounds.id, roundId))

    await tx
      .update(turns)
      .set({ status: 'ACTIVE', startedAt: now })
      .where(eq(turns.id, turn.id))

    await tx.update(players).set({ playState: 'PLAYING' }).where(eq(players.id, player.id))
  })

  const drawn = await drawNextWord(round.gameId)
  await db.insert(wordExposures).values({
    gameId: round.gameId,
    roundId: round.id,
    playerId: round.playerId,
    teamId: round.teamId,
    wordId: drawn.wordId,
    cycleNumber: drawn.cycleNumber,
    sequenceNumber: 1,
    status: 'PENDING',
  })

  await bumpGameVersion(round.gameId)
  return buildGameSnapshot(round.gameId)
}

export async function answerWord(
  roundId: string,
  playerToken: string,
  exposureId: string,
  status: 'GUESSED' | 'SKIPPED',
  idempotencyKey?: string,
) {
  void idempotencyKey
  const { round } = await assertPlayerOwnsRound(roundId, playerToken)

  const outcome = await db.transaction(async (tx) => {
    const [freshRound] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!freshRound) throw new HttpError(404, 'Раунд не найден')
    if (freshRound.status !== 'ACTIVE' && freshRound.status !== 'FINAL_WORD_GRACE') {
      throw new HttpError(409, 'Сейчас нельзя отвечать')
    }

    const [exposure] = await tx
      .select()
      .from(wordExposures)
      .where(eq(wordExposures.id, exposureId))
      .for('update')

    if (!exposure || exposure.roundId !== roundId) throw new HttpError(404, 'Слово не найдено')
    if (exposure.status !== 'PENDING') {
      return { alreadyAnswered: true as const, finished: freshRound.status === 'FINISHED' }
    }

    const now = new Date()
    await tx
      .update(wordExposures)
      .set({ status, answeredAt: now, originalStatus: status })
      .where(eq(wordExposures.id, exposureId))

    if (freshRound.status === 'FINAL_WORD_GRACE') {
      await finalizeRoundTx(tx, freshRound, 'NORMAL')
      return { alreadyAnswered: false as const, finished: true, drawNext: false }
    }

    const mainRemaining =
      freshRound.phaseEndsAt != null ? freshRound.phaseEndsAt.getTime() - now.getTime() : 0

    if (mainRemaining <= 0) {
      await finalizeRoundTx(tx, freshRound, 'NORMAL')
      return { alreadyAnswered: false as const, finished: true, drawNext: false }
    }

    return { alreadyAnswered: false as const, finished: false, drawNext: true }
  })

  if (outcome.drawNext) {
    const drawn = await drawNextWord(round.gameId)
    const [{ maxSeq }] = await db
      .select({ maxSeq: sql<number>`coalesce(max(sequence_number), 0)::int` })
      .from(wordExposures)
      .where(eq(wordExposures.roundId, roundId))

    await db.insert(wordExposures).values({
      gameId: round.gameId,
      roundId,
      playerId: round.playerId,
      teamId: round.teamId,
      wordId: drawn.wordId,
      cycleNumber: drawn.cycleNumber,
      sequenceNumber: maxSeq + 1,
      status: 'PENDING',
    })
  }

  if (outcome.finished) {
    await afterRoundFinished(round.gameId, round.turnId)
  } else {
    await bumpGameVersion(round.gameId)
  }

  return buildGameSnapshot(round.gameId)
}

async function finalizeRoundTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  round: typeof rounds.$inferSelect,
  reason: 'NORMAL' | 'DISCONNECT_TIMEOUT' | 'ADMIN_GAME_FINISH',
) {
  const now = new Date()
  await tx
    .update(rounds)
    .set({
      status: 'FINISHED',
      finishedAt: now,
      finishReason: reason,
      phaseEndsAt: null,
      disconnectDeadlineAt: null,
    })
    .where(eq(rounds.id, round.id))

  await tx
    .update(turns)
    .set({ status: 'FINISHED', finishedAt: now })
    .where(eq(turns.id, round.turnId))

  await tx.update(players).set({ playState: 'PLAYED' }).where(eq(players.id, round.playerId))

  await tx
    .update(games)
    .set({ currentTurnId: null, version: sql`${games.version} + 1` })
    .where(eq(games.id, round.gameId))
}

export async function processRoundTimers() {
  const activeRounds = await db
    .select()
    .from(rounds)
    .where(sql`${rounds.status} in ('ACTIVE', 'FINAL_WORD_GRACE', 'RECONNECTING')`)

  const now = Date.now()

  for (const round of activeRounds) {
    if (round.status === 'RECONNECTING') {
      if (round.disconnectDeadlineAt && round.disconnectDeadlineAt.getTime() <= now) {
        await forceFinishDisconnectedRound(round.id)
      }
      continue
    }

    if (!round.phaseEndsAt) continue
    if (round.phaseEndsAt.getTime() > now) continue

    if (round.status === 'ACTIVE') {
      await enterFinalGrace(round.id)
    } else if (round.status === 'FINAL_WORD_GRACE') {
      await expireFinalGrace(round.id)
    }
  }
}

async function enterFinalGrace(roundId: string) {
  let gameId: string | null = null
  await db.transaction(async (tx) => {
    const [round] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!round || round.status !== 'ACTIVE') return

    const [game] = await tx.select().from(games).where(eq(games.id, round.gameId)).limit(1)
    const graceMs = game?.finalGraceMs ?? 5000
    const now = new Date()
    gameId = round.gameId

    await tx
      .update(rounds)
      .set({
        status: 'FINAL_WORD_GRACE',
        phaseEndsAt: new Date(now.getTime() + graceMs),
      })
      .where(eq(rounds.id, roundId))
  })

  if (gameId) {
    await bumpGameVersion(gameId)
    const { broadcastGame } = await import('../ws/hub.ts')
    broadcastGame(gameId)
  }
}

async function expireFinalGrace(roundId: string) {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1)
  if (!round || round.status !== 'FINAL_WORD_GRACE') return

  await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!fresh || fresh.status !== 'FINAL_WORD_GRACE') return

    const [pending] = await tx
      .select()
      .from(wordExposures)
      .where(and(eq(wordExposures.roundId, roundId), eq(wordExposures.status, 'PENDING')))
      .orderBy(asc(wordExposures.sequenceNumber))
      .limit(1)
      .for('update')

    if (pending) {
      await tx
        .update(wordExposures)
        .set({ status: 'SKIPPED', answeredAt: new Date(), originalStatus: 'SKIPPED' })
        .where(eq(wordExposures.id, pending.id))
    }

    await finalizeRoundTx(tx, fresh, 'NORMAL')
  })

  await afterRoundFinished(round.gameId, round.turnId)
  const { broadcastGame } = await import('../ws/hub.ts')
  broadcastGame(round.gameId)
}

export async function pauseRoundForDisconnect(roundId: string) {
  await db.transaction(async (tx) => {
    const [round] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!round) return
    if (round.status !== 'ACTIVE' && round.status !== 'FINAL_WORD_GRACE') return

    const [game] = await tx.select().from(games).where(eq(games.id, round.gameId)).limit(1)
    const now = Date.now()
    const remaining = round.phaseEndsAt ? Math.max(0, round.phaseEndsAt.getTime() - now) : 0

    await tx
      .update(rounds)
      .set({
        pausedPhase: round.status,
        pausedRemainingMs: remaining,
        status: 'RECONNECTING',
        phaseEndsAt: null,
        disconnectDeadlineAt: new Date(now + (game?.disconnectGraceMs ?? 60_000)),
      })
      .where(eq(rounds.id, roundId))
  })

  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1)
  if (round) await bumpGameVersion(round.gameId)
}

export async function resumeRoundAfterReconnect(roundId: string) {
  await db.transaction(async (tx) => {
    const [round] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!round || round.status !== 'RECONNECTING') return

    const remaining = round.pausedRemainingMs ?? 0
    const resumeStatus = round.pausedPhase === 'FINAL_WORD_GRACE' ? 'FINAL_WORD_GRACE' : 'ACTIVE'
    const now = new Date()

    await tx
      .update(rounds)
      .set({
        status: resumeStatus,
        phaseEndsAt: new Date(now.getTime() + remaining),
        pausedPhase: null,
        pausedRemainingMs: null,
        disconnectDeadlineAt: null,
      })
      .where(eq(rounds.id, roundId))
  })

  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1)
  if (round) await bumpGameVersion(round.gameId)
}

async function forceFinishDisconnectedRound(roundId: string) {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1)
  if (!round || round.status !== 'RECONNECTING') return

  const unusedMainMs =
    round.pausedPhase === 'FINAL_WORD_GRACE' ? 0 : Math.max(0, round.pausedRemainingMs ?? 0)

  await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
    if (!fresh || fresh.status !== 'RECONNECTING') return

    const [pending] = await tx
      .select()
      .from(wordExposures)
      .where(and(eq(wordExposures.roundId, roundId), eq(wordExposures.status, 'PENDING')))
      .limit(1)
      .for('update')

    if (pending) {
      await tx
        .update(wordExposures)
        .set({ status: 'SKIPPED', answeredAt: new Date(), originalStatus: 'SKIPPED' })
        .where(eq(wordExposures.id, pending.id))
    }

    await finalizeRoundTx(tx, fresh, 'DISCONNECT_TIMEOUT')
  })

  if (unusedMainMs > 0) {
    await distributeBonusTime(round.gameId, round.teamId, unusedMainMs)
  }

  await afterRoundFinished(round.gameId, round.turnId)
}

async function afterRoundFinished(gameId: string, turnId: string) {
  await bumpGameVersion(gameId)
  await maybeAutoFinishGame(gameId)
  void turnId
}

export async function findActiveRoundForPlayer(playerId: string) {
  const [round] = await db
    .select()
    .from(rounds)
    .where(
      and(
        eq(rounds.playerId, playerId),
        sql`${rounds.status} in ('ACTIVE', 'FINAL_WORD_GRACE', 'RECONNECTING', 'PENDING')`,
      ),
    )
    .limit(1)
  return round ?? null
}
