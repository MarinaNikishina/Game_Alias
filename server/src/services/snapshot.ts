import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type {
  ExposureStatus,
  GameSnapshot,
  HistoryRow,
  PlayerSnapshot,
  RoundSnapshot,
  TeamSnapshot,
  TurnSnapshot,
  WordExposureSnapshot,
} from '../../../shared/src/index.ts'
import { db } from '../db/client.ts'
import {
  games,
  players,
  rounds,
  teams,
  turns,
  wordExposures,
  words,
} from '../db/schema.ts'
import { teamDisplayName } from '../lib/utils.ts'

export async function buildGameSnapshot(gameId: string): Promise<GameSnapshot> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1)
  if (!game) {
    throw new Error(`Game not found: ${gameId}`)
  }

  const teamRows = await db
    .select()
    .from(teams)
    .where(eq(teams.gameId, gameId))
    .orderBy(asc(teams.ordinal))

  const playerRows = await db.select().from(players).where(eq(players.gameId, gameId))

  const turnRows = await db
    .select()
    .from(turns)
    .where(eq(turns.gameId, gameId))
    .orderBy(asc(turns.position))

  const exposureRows = await db
    .select({
      exposure: wordExposures,
      wordText: words.text,
    })
    .from(wordExposures)
    .innerJoin(words, eq(wordExposures.wordId, words.id))
    .where(eq(wordExposures.gameId, gameId))

  const scoreByPlayer = new Map<string, { guessed: number; skipped: number }>()
  for (const row of exposureRows) {
    const current = scoreByPlayer.get(row.exposure.playerId) ?? { guessed: 0, skipped: 0 }
    if (row.exposure.status === 'GUESSED') current.guessed += 1
    if (row.exposure.status === 'SKIPPED') current.skipped += 1
    scoreByPlayer.set(row.exposure.playerId, current)
  }

  const scoreByTeam = new Map<string, number>()
  for (const player of playerRows) {
    const score = scoreByPlayer.get(player.id)?.guessed ?? 0
    scoreByTeam.set(player.teamId, (scoreByTeam.get(player.teamId) ?? 0) + score)
  }

  const memberCountByTeam = new Map<string, number>()
  for (const player of playerRows) {
    memberCountByTeam.set(player.teamId, (memberCountByTeam.get(player.teamId) ?? 0) + 1)
  }

  const teamSnapshots: TeamSnapshot[] = teamRows.map((team) => ({
    id: team.id,
    ordinal: team.ordinal,
    name: teamDisplayName(team.name, team.ordinal),
    capacity: team.capacity,
    memberCount: memberCountByTeam.get(team.id) ?? 0,
    score: scoreByTeam.get(team.id) ?? 0,
  }))

  const playerSnapshots: PlayerSnapshot[] = playerRows.map((player) => {
    const scores = scoreByPlayer.get(player.id) ?? { guessed: 0, skipped: 0 }
    return {
      id: player.id,
      teamId: player.teamId,
      name: player.name,
      connectivityState: player.connectivityState,
      playState: player.playState,
      bonusTimeMs: player.bonusTimeMs,
      guessedCount: scores.guessed,
      skippedCount: scores.skipped,
    }
  })

  const resultByPlayer = new Map<string, number>()
  for (const [playerId, scores] of scoreByPlayer) {
    resultByPlayer.set(playerId, scores.guessed)
  }

  const turnSnapshots: TurnSnapshot[] = turnRows.map((turn) => ({
    id: turn.id,
    teamId: turn.teamId,
    playerId: turn.playerId,
    position: turn.position,
    status: turn.status,
    result: turn.status === 'FINISHED' ? (resultByPlayer.get(turn.playerId) ?? 0) : null,
  }))

  let currentRound: RoundSnapshot | null = null
  if (game.currentTurnId) {
    const openStatuses = ['PENDING', 'ACTIVE', 'FINAL_WORD_GRACE', 'RECONNECTING'] as const
    const [round] = await db
      .select()
      .from(rounds)
      .where(
        and(
          eq(rounds.turnId, game.currentTurnId),
          inArray(rounds.status, [...openStatuses]),
        ),
      )
      .limit(1)

    if (round) {
      const roundExposures = exposureRows
        .filter((row) => row.exposure.roundId === round.id)
        .sort((a, b) => a.exposure.sequenceNumber - b.exposure.sequenceNumber)
        .map(
          (row): WordExposureSnapshot => ({
            id: row.exposure.id,
            wordId: row.exposure.wordId,
            text: row.wordText,
            status: row.exposure.status as ExposureStatus,
            sequenceNumber: row.exposure.sequenceNumber,
            correctedByAdmin: row.exposure.correctedByAdmin,
          }),
        )

      const currentExposure =
        roundExposures.find((item) => item.status === 'PENDING') ??
        roundExposures[roundExposures.length - 1] ??
        null

      currentRound = {
        id: round.id,
        turnId: round.turnId,
        playerId: round.playerId,
        teamId: round.teamId,
        status: round.status,
        baseDurationMs: round.baseDurationMs,
        bonusDurationMs: round.bonusDurationMs,
        startedAt: round.startedAt?.toISOString() ?? null,
        phaseEndsAt: round.phaseEndsAt?.toISOString() ?? null,
        pausedRemainingMs: round.pausedRemainingMs,
        disconnectDeadlineAt: round.disconnectDeadlineAt?.toISOString() ?? null,
        currentExposure,
        exposures: roundExposures,
        serverNow: new Date().toISOString(),
      }
    }
  }

  return {
    id: game.id,
    publicCode: game.publicCode,
    status: game.status,
    baseRoundDurationMs: game.baseRoundDurationMs,
    finalGraceMs: game.finalGraceMs,
    disconnectGraceMs: game.disconnectGraceMs,
    createdAt: game.createdAt.toISOString(),
    startedAt: game.startedAt?.toISOString() ?? null,
    finishedAt: game.finishedAt?.toISOString() ?? null,
    finishReason: game.finishReason,
    currentTurnId: game.currentTurnId,
    teams: teamSnapshots,
    players: playerSnapshots,
    turns: turnSnapshots,
    currentRound,
    joinUrlPath: `/join/${game.publicCode}`,
  }
}

export async function buildHistory(): Promise<HistoryRow[]> {
  const finished = await db
    .select()
    .from(games)
    .where(eq(games.status, 'FINISHED'))
    .orderBy(sql`${games.finishedAt} desc nulls last`)

  const rows: HistoryRow[] = []
  for (const game of finished) {
    const snapshot = await buildGameSnapshot(game.id)
    rows.push({
      id: game.id,
      publicCode: game.publicCode,
      createdAt: snapshot.createdAt,
      finishedAt: snapshot.finishedAt,
      teamNames: snapshot.teams.map((team) => team.name),
      scores: snapshot.teams.map((team) => team.score),
    })
  }
  return rows
}

export async function getFinishedRoundExposures(roundId: string): Promise<WordExposureSnapshot[]> {
  const rows = await db
    .select({
      exposure: wordExposures,
      wordText: words.text,
    })
    .from(wordExposures)
    .innerJoin(words, eq(wordExposures.wordId, words.id))
    .where(eq(wordExposures.roundId, roundId))
    .orderBy(asc(wordExposures.sequenceNumber))

  return rows.map((row) => ({
    id: row.exposure.id,
    wordId: row.exposure.wordId,
    text: row.wordText,
    status: row.exposure.status as ExposureStatus,
    sequenceNumber: row.exposure.sequenceNumber,
    correctedByAdmin: row.exposure.correctedByAdmin,
  }))
}

export async function getPlayerRoundIds(gameId: string, playerId: string) {
  return db
    .select()
    .from(rounds)
    .where(and(eq(rounds.gameId, gameId), eq(rounds.playerId, playerId), eq(rounds.status, 'FINISHED')))
}
