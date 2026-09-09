import { eq, sql } from 'drizzle-orm'
import { db } from './client.ts'
import { dictionaryVersions, words } from './schema.ts'
import { DICTIONARY_VERSION_NAME, DICTIONARY_WORDS } from './dictionary-words.ts'

export async function ensureDictionarySeeded() {
  const existing = await db
    .select()
    .from(dictionaryVersions)
    .where(eq(dictionaryVersions.name, DICTIONARY_VERSION_NAME))
    .limit(1)

  if (existing.length > 0) {
    return existing[0]
  }

  const [version] = await db
    .insert(dictionaryVersions)
    .values({ name: DICTIONARY_VERSION_NAME })
    .returning()

  await db.insert(words).values(
    DICTIONARY_WORDS.map((text) => ({
      dictionaryVersionId: version.id,
      text,
      enabled: true,
    })),
  )

  console.log(`Seeded dictionary "${DICTIONARY_VERSION_NAME}": ${DICTIONARY_WORDS.length} words`)
  return version
}

export async function getActiveDictionaryVersionId() {
  const version = await ensureDictionarySeeded()
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(words)
    .where(eq(words.dictionaryVersionId, version.id))

  if (Number(count) === 0) {
    throw new Error(`Dictionary "${DICTIONARY_VERSION_NAME}" has no words`)
  }

  return version.id
}
