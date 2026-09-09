const API = 'http://localhost:3001'

async function req(path: string, init?: RequestInit) {
  const r = await fetch(API + path, init)
  const d = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(d))
  return d
}

const c = await req('/api/games', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ teamCount: 2, capacities: [2, 2] }),
})
const a = c.adminToken
const g = c.game
const p1 = await req(`/api/games/${g.publicCode}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Starter', teamId: g.teams[0].id }),
})
await req(`/api/games/${g.publicCode}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Mate', teamId: g.teams[1].id }),
})
const started = await req(`/api/games/${g.id}/start`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${a}` },
})
const assigned = started.game.turns.find((t: { status: string }) => t.status === 'ASSIGNED')
const round = started.game.currentRound
const isP1 = assigned?.playerId === p1.playerId
console.log(
  JSON.stringify({
    status: started.game.status,
    hasAssigned: Boolean(assigned),
    roundStatus: round?.status,
    roundMatchesAssigned: round?.playerId === assigned?.playerId,
    starterCanClick: isP1 && round?.status === 'PENDING',
    otherWaits: !isP1 && round?.status === 'PENDING',
  }),
)
