export type GameStatus = 'LOBBY' | 'ACTIVE' | 'FINISHED'
export type FinishReason = 'AUTO' | 'ADMIN' | null

export type ConnectivityState = 'CONNECTED' | 'DISCONNECTED'
export type PlayState = 'WAITING' | 'ASSIGNED' | 'PLAYING' | 'PLAYED'

export type TurnStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'ACTIVE'
  | 'FINISHED'
  | 'DEFERRED'
  | 'CANCELLED'

export type RoundStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'FINAL_WORD_GRACE'
  | 'RECONNECTING'
  | 'FINISHED'

export type RoundFinishReason =
  | 'NORMAL'
  | 'DISCONNECT_TIMEOUT'
  | 'ADMIN_GAME_FINISH'
  | null

export type ExposureStatus = 'PENDING' | 'GUESSED' | 'SKIPPED'

export type ActorRole = 'ADMIN' | 'PLAYER'

export interface TeamSnapshot {
  id: string
  ordinal: number
  name: string
  capacity: number
  memberCount: number
  score: number
}

export interface PlayerSnapshot {
  id: string
  teamId: string
  name: string
  connectivityState: ConnectivityState
  playState: PlayState
  bonusTimeMs: number
  guessedCount: number
  skippedCount: number
}

export interface TurnSnapshot {
  id: string
  teamId: string
  playerId: string
  position: number
  status: TurnStatus
  result: number | null
}

export interface WordExposureSnapshot {
  id: string
  wordId: string
  text: string
  status: ExposureStatus
  sequenceNumber: number
  correctedByAdmin: boolean
}

export interface RoundSnapshot {
  id: string
  turnId: string
  playerId: string
  teamId: string
  status: RoundStatus
  baseDurationMs: number
  bonusDurationMs: number
  startedAt: string | null
  phaseEndsAt: string | null
  pausedRemainingMs: number | null
  disconnectDeadlineAt: string | null
  currentExposure: WordExposureSnapshot | null
  exposures: WordExposureSnapshot[]
  serverNow: string
}

export interface GameSnapshot {
  id: string
  publicCode: string
  status: GameStatus
  baseRoundDurationMs: number
  finalGraceMs: number
  disconnectGraceMs: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  finishReason: FinishReason
  currentTurnId: string | null
  teams: TeamSnapshot[]
  players: PlayerSnapshot[]
  turns: TurnSnapshot[]
  currentRound: RoundSnapshot | null
  joinUrlPath: string
}

export interface HistoryRow {
  id: string
  publicCode: string
  createdAt: string
  finishedAt: string | null
  teamNames: string[]
  scores: number[]
}

export interface CreateGameRequest {
  teamCount: 2 | 3
  capacities: number[]
  teamNames?: string[]
  baseRoundDurationMs?: number
}

export interface CreateGameResponse {
  game: GameSnapshot
  adminToken: string
}

export interface JoinGameRequest {
  name: string
  teamId: string
}

export interface JoinGameResponse {
  game: GameSnapshot
  playerId: string
  playerToken: string
}

export type WsClientMessage =
  | { type: 'subscribe'; gameId: string; role: ActorRole; token: string }
  | { type: 'ping' }

export type WsServerMessage =
  | { type: 'game.snapshot'; game: GameSnapshot }
  | { type: 'error'; message: string }
  | { type: 'pong'; serverNow: string }
