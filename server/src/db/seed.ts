import 'dotenv/config'
import { ensureMigrated } from './client.ts'
import { ensureDictionarySeeded } from './seed-dictionary.ts'
import { DICTIONARY_WORDS } from './dictionary-words.ts'

await ensureMigrated()
await ensureDictionarySeeded()
console.log(`Dictionary ready (${DICTIONARY_WORDS.length} words)`)
process.exit(0)
