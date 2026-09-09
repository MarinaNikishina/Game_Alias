import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const gameStatusEnum = pgEnum('game_status', ['LOBBY', 'ACTIVE', 'FINISHED'])
export const finishReasonEnum = pgEnum('finish_reason', ['AUTO', 'ADMIN'])
export const connectivityEnum = pgEnum('connectivity_state', ['CONNECTED', 'DISCONNECTED'])
export const playStateEnum = pgEnum('play_state', ['WAITING', 'ASSIGNED', 'PLAYING', 'PLAYED'])
export const turnStatusEnum = pgEnum('turn_status', [
  'PENDING',
  'ASSIGNED',
  'ACTIVE',
  'FINISHED',
  'DEFERRED',
  'CANCELLED',
])
export const roundStatusEnum = pgEnum('round_status', [
  'PENDING',
  'ACTIVE',
  'FINAL_WORD_GRACE',
  'RECONNECTING',
  'FINISHED',
])
export const roundFinishReasonEnum = pgEnum('round_finish_reason', [
  'NORMAL',
  'DISCONNECT_TIMEOUT',
  'ADMIN_GAME_FINISH',
])
export const exposureStatusEnum = pgEnum('exposure_status', ['PENDING', 'GUESSED', 'SKIPPED'])

export const games = pgTable('games', {
  id: uuid('id').defaultRandom().primaryKey(),
  publicCode: text('public_code').notNull().unique(),
  status: gameStatusEnum('status').notNull().default('LOBBY'),
  baseRoundDurationMs: integer('base_round_duration_ms').notNull().default(120_000),
  finalGraceMs: integer('final_grace_ms').notNull().default(5_000),
  disconnectGraceMs: integer('disconnect_grace_ms').notNull().default(60_000),
  dictionaryVersionId: uuid('dictionary_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  finishReason: finishReasonEnum('finish_reason'),
  currentTurnId: uuid('current_turn_id'),
  version: integer('version').notNull().default(0),
})

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  secretTokenHash: text('secret_token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    name: text('name'),
    capacity: integer('capacity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('teams_game_ordinal_uidx').on(t.gameId, t.ordinal)],
)

export const players = pgTable(
  'players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    sessionTokenHash: text('session_token_hash').notNull(),
    connectivityState: connectivityEnum('connectivity_state').notNull().default('CONNECTED'),
    playState: playStateEnum('play_state').notNull().default('WAITING'),
    bonusTimeMs: integer('bonus_time_ms').notNull().default(0),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('players_game_normalized_name_uidx').on(t.gameId, t.normalizedName)],
)

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    status: turnStatusEnum('status').notNull().default('PENDING'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('turns_game_position_uidx').on(t.gameId, t.position)],
)

export const rounds = pgTable('rounds', {
  id: uuid('id').defaultRandom().primaryKey(),
  turnId: uuid('turn_id')
    .notNull()
    .references(() => turns.id, { onDelete: 'cascade' }),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  status: roundStatusEnum('status').notNull().default('PENDING'),
  baseDurationMs: integer('base_duration_ms').notNull(),
  bonusDurationMs: integer('bonus_duration_ms').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  phaseEndsAt: timestamp('phase_ends_at', { withTimezone: true }),
  pausedPhase: roundStatusEnum('paused_phase'),
  pausedRemainingMs: integer('paused_remaining_ms'),
  disconnectDeadlineAt: timestamp('disconnect_deadline_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  finishReason: roundFinishReasonEnum('finish_reason'),
})

export const dictionaryVersions = pgTable('dictionary_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const words = pgTable('words', {
  id: uuid('id').defaultRandom().primaryKey(),
  dictionaryVersionId: uuid('dictionary_version_id')
    .notNull()
    .references(() => dictionaryVersions.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  enabled: boolean('enabled').notNull().default(true),
})

export const gameDeckCycles = pgTable(
  'game_deck_cycles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    cycleNumber: integer('cycle_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('deck_cycles_game_cycle_uidx').on(t.gameId, t.cycleNumber)],
)

export const gameDeckItems = pgTable(
  'game_deck_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => gameDeckCycles.id, { onDelete: 'cascade' }),
    wordId: uuid('word_id')
      .notNull()
      .references(() => words.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deck_items_cycle_position_uidx').on(t.cycleId, t.position),
    uniqueIndex('deck_items_cycle_word_uidx').on(t.cycleId, t.wordId),
  ],
)

export const wordExposures = pgTable('word_exposures', {
  id: uuid('id').defaultRandom().primaryKey(),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id')
    .notNull()
    .references(() => rounds.id, { onDelete: 'cascade' }),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  wordId: uuid('word_id')
    .notNull()
    .references(() => words.id, { onDelete: 'cascade' }),
  cycleNumber: integer('cycle_number').notNull(),
  sequenceNumber: integer('sequence_number').notNull(),
  status: exposureStatusEnum('status').notNull().default('PENDING'),
  shownAt: timestamp('shown_at', { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  originalStatus: exposureStatusEnum('original_status'),
  correctedAt: timestamp('corrected_at', { withTimezone: true }),
  correctedByAdmin: boolean('corrected_by_admin').notNull().default(false),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  gameId: uuid('game_id').references(() => games.id, { onDelete: 'cascade' }),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  action: text('action').notNull(),
  payloadJson: jsonb('payload_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const gameCodeCounter = pgTable('game_code_counter', {
  id: integer('id').primaryKey().default(1),
  nextValue: integer('next_value').notNull().default(1),
})
