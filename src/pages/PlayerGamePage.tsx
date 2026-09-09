import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@moysklad/uikit'
import type { GameSnapshot } from '../../shared/src/index.ts'
import { api, connectGameSocket, playerSessionKey } from '../api'
import { formatQueueState, remainingLabel } from '../lib/format'

interface Session {
  playerId: string
  token: string
}

export default function PlayerGamePage() {
  const { gameId = '' } = useParams()
  const [game, setGame] = useState<GameSnapshot | null>(null)
  const [error, setError] = useState('')
  const [locked, setLocked] = useState(false)
  const [starting, setStarting] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(playerSessionKey(gameId))
    return raw ? (JSON.parse(raw) as Session) : null
  })

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!gameId || !session) return
    let cancelled = false
    api
      .restorePlayer(gameId, session.token)
      .then((res) => {
        if (!cancelled) {
          setGame(res.game)
          setSession({ playerId: res.playerId, token: session.token })
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка сессии'))

    const disconnect = connectGameSocket(gameId, 'PLAYER', session.token, setGame)
    return () => {
      cancelled = true
      disconnect()
    }
  }, [gameId, session?.token])

  const myTurn = useMemo(() => {
    if (!game || !session) return null
    return (
      game.turns.find(
        (turn) =>
          turn.playerId === session.playerId &&
          (turn.status === 'ASSIGNED' || turn.status === 'ACTIVE'),
      ) ?? null
    )
  }, [game, session])

  const myPendingRound = useMemo(() => {
    if (!game || !session) return null
    if (
      game.currentRound &&
      game.currentRound.playerId === session.playerId &&
      game.currentRound.status === 'PENDING'
    ) {
      return game.currentRound
    }
    return null
  }, [game, session])

  const canStartRound = Boolean(myTurn?.status === 'ASSIGNED' && myPendingRound)

  const isMyActiveRound =
    Boolean(game?.currentRound) &&
    game?.currentRound?.playerId === session?.playerId &&
    (game?.currentRound?.status === 'ACTIVE' ||
      game?.currentRound?.status === 'FINAL_WORD_GRACE' ||
      game?.currentRound?.status === 'RECONNECTING')

  async function onStartRound() {
    if (!myPendingRound || !session || starting) return
    setStarting(true)
    setError('')
    try {
      const res = await api.startRound(myPendingRound.id, session.token)
      setGame(res.game)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось начать раунд')
    } finally {
      setStarting(false)
    }
  }

  async function onAnswer(status: 'GUESSED' | 'SKIPPED') {
    if (!game?.currentRound?.currentExposure || !session || locked) return
    setLocked(true)
    setError('')
    try {
      const res = await api.answer(
        game.currentRound.id,
        session.token,
        game.currentRound.currentExposure.id,
        status,
      )
      setGame(res.game)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка ответа')
    } finally {
      window.setTimeout(() => setLocked(false), 1000)
    }
  }

  if (!session) {
    return (
      <div className="app-shell">
        <p>Сессия игрока не найдена.</p>
        <Link to="/">Назад</Link>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="app-shell">
        <p>Загрузка…</p>
        {error ? <p className="error">{error}</p> : null}
      </div>
    )
  }

  if (game.status === 'FINISHED') {
    return (
      <div className="app-shell">
        <h1 className="app-title">Игра завершена</h1>
        <div className="scoreboard">
          {game.teams.map((team) => (
            <div className="score-card" key={team.id}>
              <div className="name">{team.name}</div>
              <div className="value">{team.score}</div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (isMyActiveRound && game.currentRound) {
    const endsAt = game.currentRound.phaseEndsAt
    const label = endsAt
      ? remainingLabel(endsAt, new Date(now).toISOString())
      : game.currentRound.status === 'RECONNECTING'
        ? 'Переподключение…'
        : '--:--'

    return (
      <div className="app-shell">
        <div className="round-timer">{label}</div>
        {game.currentRound.status === 'FINAL_WORD_GRACE' ? (
          <p style={{ textAlign: 'center' }}>Время вышло. Завершите последнее слово.</p>
        ) : null}
        {game.currentRound.status === 'RECONNECTING' ? (
          <p style={{ textAlign: 'center' }}>Игрок переподключается</p>
        ) : null}
        <div className="round-word">{game.currentRound.currentExposure?.text ?? '—'}</div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button disabled={locked} onClick={() => void onAnswer('GUESSED')}>
            Угадали
          </Button>
          <Button disabled={locked} onClick={() => void onAnswer('SKIPPED')}>
            Пропустить
          </Button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="app-shell">
      <h1 className="app-title">{game.publicCode}</h1>
      <p className="app-subtitle">
        {canStartRound
          ? 'Ваш ход — нажмите «Начать раунд»'
          : game.status === 'LOBBY'
            ? 'Ожидаем старта игры'
            : 'Ожидайте своего хода'}
      </p>

      <div className="scoreboard">
        {game.teams.map((team) => (
          <div className="score-card" key={team.id}>
            <div className="name">{team.name}</div>
            <div className="value">{team.score}</div>
          </div>
        ))}
      </div>

      {canStartRound ? (
        <div className="panel" style={{ textAlign: 'center' }}>
          <p style={{ marginTop: 0 }}>Ход назначен вам. Объясняйте слова своей команде.</p>
          <Button isLoading={starting} onClick={() => void onStartRound()}>
            Начать раунд
          </Button>
        </div>
      ) : null}

      <section className="panel">
        <h2>Очередь</h2>
        {game.turns.length === 0 ? (
          <p className="muted">Очередь появится после старта игры.</p>
        ) : (
          <ul className="queue">
            {game.turns.map((turn) => {
              const player = game.players.find((item) => item.id === turn.playerId)
              const team = game.teams.find((item) => item.id === turn.teamId)
              return (
                <li key={turn.id}>
                  <span>{team?.name}</span>
                  <span>{player?.name}</span>
                  <span>{formatQueueState(turn, session.playerId)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
