import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Input } from '@moysklad/uikit'
import type { GameSnapshot } from '../../shared/src/index.ts'
import { api, playerSessionKey } from '../api'

export default function JoinPage() {
  const { publicCode = '' } = useParams()
  const navigate = useNavigate()
  const [game, setGame] = useState<GameSnapshot | null>(null)
  const [name, setName] = useState('')
  const [teamId, setTeamId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .getGameByCode(publicCode)
      .then((res) => {
        setGame(res.game)
        const existing = localStorage.getItem(playerSessionKey(res.game.id))
        if (existing) {
          navigate(`/game/${res.game.id}`)
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Игра не найдена'))
  }, [publicCode, navigate])

  async function onJoin() {
    if (!game || !teamId) return
    setBusy(true)
    setError('')
    try {
      const result = await api.join(publicCode, name, teamId)
      localStorage.setItem(
        playerSessionKey(result.game.id),
        JSON.stringify({ playerId: result.playerId, token: result.playerToken }),
      )
      navigate(`/game/${result.game.id}/rules`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти')
    } finally {
      setBusy(false)
    }
  }

  if (!game && !error) {
    return (
      <div className="app-shell">
        <p>Загрузка…</p>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="app-shell">
        <p className="error">{error}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <h1 className="app-title">Вход в {game.publicCode}</h1>
      <p className="app-subtitle">Выберите команду и имя. Администратор управляет ходом игры.</p>

      <section className="panel">
        <div className="field" style={{ marginBottom: 16 }}>
          <label>Ваше имя</label>
          <Input
            name="playerName"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="team-list">
          {game.teams.map((team) => {
            const full = team.memberCount >= team.capacity
            return (
              <button
                key={team.id}
                type="button"
                className={`team-option ${teamId === team.id ? 'active' : ''}`}
                disabled={full || game.status === 'FINISHED'}
                onClick={() => setTeamId(team.id)}
              >
                <span>{team.name}</span>
                <span className="muted">
                  {team.memberCount}/{team.capacity}
                </span>
              </button>
            )
          })}
        </div>

        <div style={{ marginTop: 16 }}>
          <Button
            isLoading={busy}
            disabled={!name.trim() || !teamId}
            onClick={() => void onJoin()}
          >
            Присоединиться
          </Button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </div>
  )
}
