import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from './schema.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '../../../.env') })
config()

const dataDir = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, '../../../data/pglite')
mkdirSync(dataDir, { recursive: true })

export const client = new PGlite(dataDir)
export const db = drizzle(client, { schema })

let migrated = false

export async function ensureMigrated() {
  if (migrated) return
  await client.exec(`
    DO $$ BEGIN
      CREATE TYPE game_status AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE finish_reason AS ENUM ('AUTO', 'ADMIN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE connectivity_state AS ENUM ('CONNECTED', 'DISCONNECTED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE play_state AS ENUM ('WAITING', 'ASSIGNED', 'PLAYING', 'PLAYED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE turn_status AS ENUM ('PENDING', 'ASSIGNED', 'ACTIVE', 'FINISHED', 'DEFERRED', 'CANCELLED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE round_status AS ENUM ('PENDING', 'ACTIVE', 'FINAL_WORD_GRACE', 'RECONNECTING', 'FINISHED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE round_finish_reason AS ENUM ('NORMAL', 'DISCONNECT_TIMEOUT', 'ADMIN_GAME_FINISH');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    DO $$ BEGIN
      CREATE TYPE exposure_status AS ENUM ('PENDING', 'GUESSED', 'SKIPPED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE TABLE IF NOT EXISTS dictionary_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS words (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dictionary_version_id uuid NOT NULL REFERENCES dictionary_versions(id) ON DELETE CASCADE,
      text text NOT NULL,
      enabled boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS games (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      public_code text NOT NULL UNIQUE,
      status game_status NOT NULL DEFAULT 'LOBBY',
      base_round_duration_ms integer NOT NULL DEFAULT 120000,
      final_grace_ms integer NOT NULL DEFAULT 5000,
      disconnect_grace_ms integer NOT NULL DEFAULT 60000,
      dictionary_version_id uuid REFERENCES dictionary_versions(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      finish_reason finish_reason,
      current_turn_id uuid,
      version integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      secret_token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS teams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      ordinal integer NOT NULL,
      name text,
      capacity integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS teams_game_ordinal_uidx ON teams(game_id, ordinal);

    CREATE TABLE IF NOT EXISTS players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name text NOT NULL,
      normalized_name text NOT NULL,
      session_token_hash text NOT NULL,
      connectivity_state connectivity_state NOT NULL DEFAULT 'CONNECTED',
      play_state play_state NOT NULL DEFAULT 'WAITING',
      bonus_time_ms integer NOT NULL DEFAULT 0,
      joined_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS players_game_normalized_name_uidx ON players(game_id, normalized_name);

    CREATE TABLE IF NOT EXISTS turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      position integer NOT NULL,
      status turn_status NOT NULL DEFAULT 'PENDING',
      assigned_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS turns_game_position_uidx ON turns(game_id, position);

    CREATE TABLE IF NOT EXISTS rounds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      status round_status NOT NULL DEFAULT 'PENDING',
      base_duration_ms integer NOT NULL,
      bonus_duration_ms integer NOT NULL DEFAULT 0,
      started_at timestamptz,
      phase_ends_at timestamptz,
      paused_phase round_status,
      paused_remaining_ms integer,
      disconnect_deadline_at timestamptz,
      finished_at timestamptz,
      finish_reason round_finish_reason
    );

    CREATE TABLE IF NOT EXISTS game_deck_cycles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      cycle_number integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deck_cycles_game_cycle_uidx ON game_deck_cycles(game_id, cycle_number);

    CREATE TABLE IF NOT EXISTS game_deck_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id uuid NOT NULL REFERENCES game_deck_cycles(id) ON DELETE CASCADE,
      word_id uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      position integer NOT NULL,
      consumed_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deck_items_cycle_position_uidx ON game_deck_items(cycle_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS deck_items_cycle_word_uidx ON game_deck_items(cycle_id, word_id);

    CREATE TABLE IF NOT EXISTS word_exposures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      word_id uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      cycle_number integer NOT NULL,
      sequence_number integer NOT NULL,
      status exposure_status NOT NULL DEFAULT 'PENDING',
      shown_at timestamptz NOT NULL DEFAULT now(),
      answered_at timestamptz,
      original_status exposure_status,
      corrected_at timestamptz,
      corrected_by_admin boolean NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid REFERENCES games(id) ON DELETE CASCADE,
      actor_type text NOT NULL,
      actor_id text,
      entity_type text NOT NULL,
      entity_id text,
      action text NOT NULL,
      payload_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS game_code_counter (
      id integer PRIMARY KEY DEFAULT 1,
      next_value integer NOT NULL DEFAULT 1
    );
  `)
  migrated = true
}
