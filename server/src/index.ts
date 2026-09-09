import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './routes/app.ts'
import { attachWebSocket } from './ws/hub.ts'
import { processRoundTimers } from './services/round.ts'
import { ensureMigrated } from './db/client.ts'
import { ensureDictionarySeeded } from './db/seed-dictionary.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '../../.env') })
config()

await ensureMigrated()
await ensureDictionarySeeded()

const port = Number(process.env.PORT || 3001)
const app = createApp()
const clientDist = path.resolve(__dirname, '../../dist')

if (existsSync(clientDist)) {
  app.use('/*', serveStatic({ root: clientDist }))
  app.get('*', serveStatic({ root: clientDist, path: 'index.html' }))
}

const server = serve({
  fetch: app.fetch,
  port,
  hostname: process.env.HOST || '0.0.0.0',
})

attachWebSocket(server as unknown as import('node:http').Server)

setInterval(async () => {
  try {
    await processRoundTimers()
  } catch (error) {
    console.error('Timer tick failed', error)
  }
}, 500)

console.log(`Game Alias server listening on :${port}`)
