import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Input } from '@moysklad/uikit'
import type { GameSnapshot, WordExposureSnapshot } from '../../shared/src/index.ts'
import { adminTokenKey, api, connectGameSocket } from '../api'
import { formatQueueState, remainingLabel } from '../lib/format'

export default function AdminGamePage() {
  const { gameId = '' } = useParams()
  const navigate = useNavigate()
  const [game, setGame] = useState<GameSnapshot | null>(null)
  const [error, setError] = useState('')
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null)
  const [exposures, setExposures] = useState<WordExposureSnapshot[]>([])
  const token = localStorage.getItem(adminTokenKey(gameId)) || ''

  useEffect(() => {
    if (!gameId || !token) return
    let cancelled = false
    api
      .getGame(gameId)
      .then((res) => {
        if (!cancelled) setGame(res.game)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка'))
    const disconnect = connectGameSocket(gameId, 'ADMIN', token, setGame)
    return () => {
      cancelled = true
      disconnect()
    }
  }, [gameId, token])

  const assignedTurn = useMemo(
    () => game?.turns.find((turn) => turn.status === 'ASSIGNED') ?? null,
    [game],
  )

  const canDefer = useMemo(() => {
    if (!game || !assignedTurn) return false
    return game.turns.some(
      (turn) =>
        turn.teamId === assignedTurn.teamId &&
        turn.status === 'PENDING' &&
        turn.id !== assignedTurn.id,
    )
  }, [game, assignedTurn])

  async function run(action: () => Promise<{ game: GameSnapshot }>) {
    setError('')
    try {
      const res = await action()
      setGame(res.game)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка')
    }
  }

  async function openDrawer(playerId: string) {
    setDrawerPlayerId(playerId)
    const res = await api.playerExposures(gameId, playerId, token)
    setExposures(res.exposures as WordExposureSnapshot[])
  }

  if (!token) {
    return (
      <div className="app-shell">
        <p>Нет токена администратора для этой игры. Создайте новую игру с главной.</p>
        <Link to="/admin">На главную</Link>
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

  const joinUrl = `${window.location.origin}${game.joinUrlPath}`
  const currentPlayer = game.players.find((player) => player.id === game.currentRound?.playerId)
  const currentTeam = game.teams.find((team) => team.id === game.currentRound?.teamId)

  return (
    <div className="app-shell">
      <div className="sticky-admin">
        <h1 className="app-title">{game.publicCode}</h1>
        <p className="app-subtitle">
          Статус: {game.status}
          {game.currentRound
            ? ` · Играет ${currentPlayer?.name ?? '—'} из команды ${currentTeam?.name ?? '—'}`
            : ' · Раунд не идёт'}
          {game.currentRound?.phaseEndsAt
            ? ` · ${remainingLabel(game.currentRound.phaseEndsAt, game.currentRound.serverNow)}`
            : ''}
        </p>

        <div className="scoreboard">
          {game.teams.map((team) => (
            <div className="score-card" key={team.id}>
              <div className="name">{team.name}</div>
              <div className="value">{team.score}</div>
            </div>
          ))}
        </div>

        <div className="row">
          <Button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(joinUrl)
            }}
          >
            Скопировать ссылку
          </Button>
          {game.status === 'LOBBY' ? (
            <Button type="button" onClick={() => void run(() => api.startGame(game.id, token))}>
              Начать игру
            </Button>
          ) : null}
          {game.status === 'ACTIVE' ? (
            <>
              <Button
                type="button"
                disabled={Boolean(
                  game.turns.some((turn) => turn.status === 'ASSIGNED' || turn.status === 'ACTIVE'),
                )}
                onClick={() => void run(() => api.nextTurn(game.id, token))}
              >
                Следующий ход
              </Button>
              <Button
                type="button"
                disabled={!canDefer || !assignedTurn}
                onClick={() =>
                  assignedTurn && void run(() => api.deferTurn(game.id, assignedTurn.id, token))
                }
              >
                Отложить ход
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Завершить игру? Некоторые игроки могут ещё не успеть сыграть.',
                    )
                  ) {
                    void run(() => api.finishGame(game.id, token))
                  }
                }}
              >
                Завершить игру
              </Button>
            </>
          ) : null}
          {game.status === 'FINISHED' ? (
            <Button
              type="button"
              onClick={() =>
                void (async () => {
                  const res = await api.replayGame(game.id, token)
                  localStorage.setItem(adminTokenKey(res.game.id), res.adminToken)
                  navigate(`/admin/game/${res.game.id}`)
                })()
              }
            >
              Сыграть ещё раз
            </Button>
          ) : null}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Ссылка для игроков: {joinUrl}
        </p>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {game.status === 'LOBBY' ? (
        <section className="panel">
          <h2>Команды в лобби</h2>
          {game.teams.map((team) => (
            <div key={team.id} className="row" style={{ marginBottom: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>
                  {team.name} ({team.memberCount}/{team.capacity})
                </label>
                <Input
                  name={`team-${team.id}`}
                  defaultValue={team.name}
                  onBlur={(event) => {
                    const name = event.target.value.trim()
                    if (name && name !== team.name) {
                      void run(() => api.renameTeam(game.id, team.id, name, token))
                    }
                  }}
                />
              </div>
            </div>
          ))}
          <ul>
            {game.players.map((player) => {
              const team = game.teams.find((item) => item.id === player.teamId)
              return (
                <li key={player.id}>
                  {player.name} → {team?.name}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h2>Очередь</h2>
        <ul className="queue">
          {game.turns.map((turn) => {
            const player = game.players.find((item) => item.id === turn.playerId)
            const team = game.teams.find((item) => item.id === turn.teamId)
            return (
              <li key={turn.id}>
                <span>{team?.name}</span>
                <span>{player?.name}</span>
                <span>{formatQueueState(turn, null)}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>Отчёт по командам</h2>
        <div className="report-grid">
          {game.teams.map((team) => (
            <div key={team.id}>
              <h3>
                {team.name} · {team.score}
              </h3>
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Игрок</th>
                    <th>Угадано</th>
                    <th>Пропущено</th>
                  </tr>
                </thead>
                <tbody>
                  {game.players
                    .filter((player) => player.teamId === team.id)
                    .map((player) => (
                      <tr key={player.id} onClick={() => void openDrawer(player.id)}>
                        <td>{player.name}</td>
                        <td>{player.playState === 'WAITING' ? '—' : player.guessedCount}</td>
                        <td>{player.playState === 'WAITING' ? '—' : player.skippedCount}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      {drawerPlayerId ? (
        <div className="drawer-backdrop" onClick={() => setDrawerPlayerId(null)}>
          <div className="drawer" onClick={(event) => event.stopPropagation()}>
            <h2>Слова игрока</h2>
            <Button onClick={() => setDrawerPlayerId(null)}>Закрыть</Button>
            <ul>
              {exposures.map((exposure) => (
                <li key={exposure.id} className="row" style={{ marginTop: 8 }}>
                  <span style={{ flex: 1 }}>
                    {exposure.text} — {exposure.status === 'GUESSED' ? 'Угадано' : 'Пропущено'}
                  </span>
                  <Button
                    onClick={() =>
                      void run(async () => {
                        const next = exposure.status === 'GUESSED' ? 'SKIPPED' : 'GUESSED'
                        const res = await api.correctExposure(exposure.id, next, token)
                        const refreshed = await api.playerExposures(gameId, drawerPlayerId, token)
                        setExposures(refreshed.exposures as WordExposureSnapshot[])
                        return res
                      })
                    }
                  >
                    Переключить
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}
