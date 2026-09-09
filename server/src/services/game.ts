import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  adminSessions,
  dictionaryVersions,
  gameCodeCounter,
  games,
  players,
  teams,
  words,
} from '../db/schema.ts'
import { createToken, hashToken, HttpError } from '../lib/utils.ts'
import { buildGameSnapshot, buildHistory } from './snapshot.ts'
import { ensureDeckCycle } from './deck.ts'
import { generateInitialQueue } from './queue.ts'
import { DICTIONARY_VERSION_NAME } from '../db/dictionary-words.ts'

export interface CreateGameInput {
  teamCount: 2 | 3
  capacities: number[]
  teamNames?: string[]
  baseRoundDurationMs?: number
}

export async function createGame(input: CreateGameInput) {
  if (input.capacities.length !== input.teamCount) {
    throw new HttpError(400, 'Количество вместимостей должно совпадать с числом команд')
  }
  if (input.capacities.some((cap) => !Number.isInteger(cap) || cap < 1 || cap > 20)) {
    throw new HttpError(400, 'Вместимость команды должна быть от 1 до 20')
  }

  const adminToken = createToken()
  const adminTokenHash = hashToken(adminToken)

  const result = await db.transaction(async (tx) => {
    const [counter] = await tx
      .select()
      .from(gameCodeCounter)
      .where(eq(gameCodeCounter.id, 1))
      .for('update')

    let nextValue = 1
    if (!counter) {
      await tx.insert(gameCodeCounter).values({ id: 1, nextValue: 2 })
    } else {
      nextValue = counter.nextValue
      await tx
        .update(gameCodeCounter)
        .set({ nextValue: counter.nextValue + 1 })
        .where(eq(gameCodeCounter.id, 1))
    }

    const publicCode = `Game${nextValue}`

    const [dictionary] = await tx
      .select()
      .from(dictionaryVersions)
      .where(eq(dictionaryVersions.name, DICTIONARY_VERSION_NAME))
      .limit(1)
    if (!dictionary) {
      throw new HttpError(500, 'Словарь не инициализирован. Перезапустите сервер.')
    }

    const wordCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(words)
      .where(eq(words.dictionaryVersionId, dictionary.id))
    if ((wordCount[0]?.count ?? 0) === 0) {
      throw new HttpError(500, 'Словарь пуст. Перезапустите сервер.')
    }

    const [game] = await tx
      .insert(games)
      .values({
        publicCode,
        status: 'LOBBY',
        baseRoundDurationMs: input.baseRoundDurationMs ?? 120_000,
        dictionaryVersionId: dictionary.id,
      })
      .returning()

    const teamValues = Array.from({ length: input.teamCount }, (_, index) => ({
      gameId: game.id,
      ordinal: index + 1,
      capacity: input.capacities[index],
      name: input.teamNames?.[index]?.trim() || null,
    }))

    await tx.insert(teams).values(teamValues)

    await tx.insert(adminSessions).values({
      gameId: game.id,
      secretTokenHash: adminTokenHash,
    })

    return game
  })

  await ensureDeckCycle(result.id)

  const game = await buildGameSnapshot(result.id)
  return { game, adminToken }
}

export async function getGameByPublicCode(publicCode: string) {
  const [game] = await db.select().from(games).where(eq(games.publicCode, publicCode)).limit(1)
  if (!game) throw new HttpError(404, 'Игра не найдена')
  return buildGameSnapshot(game.id)
}

export async function getGameById(gameId: string) {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1)
  if (!game) throw new HttpError(404, 'Игра не найдена')
  return buildGameSnapshot(game.id)
}

export async function assertAdmin(gameId: string, token: string) {
  const tokenHash = hashToken(token)
  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.gameId, gameId))
    .limit(1)

  if (!session || session.secretTokenHash !== tokenHash) {
    throw new HttpError(401, 'Нет доступа администратора')
  }

  await db
    .update(adminSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(adminSessions.id, session.id))

  return session
}

export async function renameTeam(gameId: string, teamId: string, name: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)
  const trimmed = name.trim()
  if (!trimmed) throw new HttpError(400, 'Название команды не может быть пустым')

  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1)
  if (!team || team.gameId !== gameId) throw new HttpError(404, 'Команда не найдена')

  await db.update(teams).set({ name: trimmed }).where(eq(teams.id, teamId))
  await bumpGameVersion(gameId)
  return buildGameSnapshot(gameId)
}

export async function startGame(gameId: string, adminToken: string) {
  await assertAdmin(gameId, adminToken)

  await db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId))
    if (!game) throw new HttpError(404, 'Игра не найдена')
    if (game.status !== 'LOBBY') throw new HttpError(409, 'Игру можно начать только из лобби')

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(players)
      .where(eq(players.gameId, gameId))

    if (Number(count) < 2) throw new HttpError(400, 'Нужно минимум 2 игрока, чтобы начать игру')

    await tx
      .update(games)
      .set({
        status: 'ACTIVE',
        startedAt: new Date(),
        version: game.version + 1,
      })
      .where(eq(games.id, gameId))
  })

  await generateInitialQueue(gameId)
  // Сразу назначаем первый ход: раунд стартует только по кнопке игрока.
  const { assignNextTurn } = await import('./turn.ts')
  return assignNextTurn(gameId, adminToken)
}

export async function listHistory() {
  return buildHistory()
}

export async function bumpGameVersion(gameId: string) {
  await db
    .update(games)
    .set({ version: sql`${games.version} + 1` })
    .where(eq(games.id, gameId))
}

export async function getTeamsOrdered(gameId: string) {
  return db.select().from(teams).where(eq(teams.gameId, gameId)).orderBy(asc(teams.ordinal))
}
