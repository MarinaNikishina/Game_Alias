import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { players, turns } from '../db/schema.ts'
import { shuffleInPlace } from '../lib/utils.ts'

export async function generateInitialQueue(gameId: string) {
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(turns).where(eq(turns.gameId, gameId)).limit(1)
    if (existing.length > 0) return

    const playerRows = await tx.select().from(players).where(eq(players.gameId, gameId))
    const byTeam = new Map<string, typeof playerRows>()
    for (const player of playerRows) {
      const list = byTeam.get(player.teamId) ?? []
      list.push(player)
      byTeam.set(player.teamId, list)
    }

    for (const [, list] of byTeam) {
      shuffleInPlace(list)
    }

    const teamIds = [...byTeam.keys()]
    const cursors = new Map(teamIds.map((id) => [id, 0]))
    const queue: { teamId: string; playerId: string }[] = []

    while (queue.length < playerRows.length) {
      const available = teamIds.filter((teamId) => {
        const list = byTeam.get(teamId) ?? []
        return (cursors.get(teamId) ?? 0) < list.length
      })
      shuffleInPlace(available)
      for (const teamId of available) {
        const list = byTeam.get(teamId)!
        const index = cursors.get(teamId)!
        const player = list[index]
        cursors.set(teamId, index + 1)
        queue.push({ teamId, playerId: player.id })
      }
    }

    if (queue.length > 0) {
      await tx.insert(turns).values(
        queue.map((item, index) => ({
          gameId,
          teamId: item.teamId,
          playerId: item.playerId,
          position: index + 1,
          status: 'PENDING' as const,
        })),
      )
    }
  })
}

export async function getOrderedTurns(gameId: string) {
  return db.select().from(turns).where(eq(turns.gameId, gameId)).orderBy(asc(turns.position))
}

export async function getPendingTurns(gameId: string) {
  return db
    .select()
    .from(turns)
    .where(and(eq(turns.gameId, gameId), eq(turns.status, 'PENDING')))
    .orderBy(asc(turns.position))
}
