import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { gameDeckCycles, gameDeckItems, games, words } from '../db/schema.ts'
import { HttpError, shuffleInPlace } from '../lib/utils.ts'

async function insertShuffledCycle(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  gameId: string,
  cycleNumber: number,
  previousLastWordId: string | null,
) {
  const [game] = await tx.select().from(games).where(eq(games.id, gameId)).limit(1)
  if (!game?.dictionaryVersionId) throw new HttpError(500, 'У игры нет словаря')

  const enabledWords = await tx
    .select()
    .from(words)
    .where(and(eq(words.dictionaryVersionId, game.dictionaryVersionId), eq(words.enabled, true)))

  if (enabledWords.length === 0) throw new HttpError(500, 'Словарь пуст')

  const shuffled = shuffleInPlace([...enabledWords])
  if (previousLastWordId && shuffled.length > 1 && shuffled[0].id === previousLastWordId) {
    const swapWith = 1 + Math.floor(Math.random() * (shuffled.length - 1))
    ;[shuffled[0], shuffled[swapWith]] = [shuffled[swapWith], shuffled[0]]
  }

  const [cycle] = await tx
    .insert(gameDeckCycles)
    .values({ gameId, cycleNumber })
    .returning()

  await tx.insert(gameDeckItems).values(
    shuffled.map((word, index) => ({
      cycleId: cycle.id,
      wordId: word.id,
      position: index + 1,
    })),
  )

  return cycle
}

export async function ensureDeckCycle(gameId: string) {
  const existing = await db
    .select()
    .from(gameDeckCycles)
    .where(eq(gameDeckCycles.gameId, gameId))
    .orderBy(asc(gameDeckCycles.cycleNumber))

  if (existing.length > 0) return existing[existing.length - 1]

  return db.transaction(async (tx) => insertShuffledCycle(tx, gameId, 1, null))
}

export async function drawNextWord(gameId: string) {
  return db.transaction(async (tx) => {
    let cycles = await tx
      .select()
      .from(gameDeckCycles)
      .where(eq(gameDeckCycles.gameId, gameId))
      .orderBy(asc(gameDeckCycles.cycleNumber))

    if (cycles.length === 0) {
      const cycle = await insertShuffledCycle(tx, gameId, 1, null)
      cycles = [cycle]
    }

    let currentCycle = cycles[cycles.length - 1]

    let [nextItem] = await tx
      .select()
      .from(gameDeckItems)
      .where(and(eq(gameDeckItems.cycleId, currentCycle.id), isNull(gameDeckItems.consumedAt)))
      .orderBy(asc(gameDeckItems.position))
      .limit(1)
      .for('update')

    if (!nextItem) {
      const [lastConsumed] = await tx
        .select()
        .from(gameDeckItems)
        .where(eq(gameDeckItems.cycleId, currentCycle.id))
        .orderBy(sql`${gameDeckItems.position} desc`)
        .limit(1)

      currentCycle = await insertShuffledCycle(
        tx,
        gameId,
        currentCycle.cycleNumber + 1,
        lastConsumed?.wordId ?? null,
      )

      ;[nextItem] = await tx
        .select()
        .from(gameDeckItems)
        .where(and(eq(gameDeckItems.cycleId, currentCycle.id), isNull(gameDeckItems.consumedAt)))
        .orderBy(asc(gameDeckItems.position))
        .limit(1)
        .for('update')
    }

    if (!nextItem) throw new HttpError(500, 'Не удалось взять слово из колоды')

    await tx
      .update(gameDeckItems)
      .set({ consumedAt: new Date() })
      .where(eq(gameDeckItems.id, nextItem.id))

    const [word] = await tx.select().from(words).where(eq(words.id, nextItem.wordId)).limit(1)
    return {
      wordId: nextItem.wordId,
      text: word.text,
      cycleNumber: currentCycle.cycleNumber,
    }
  })
}
