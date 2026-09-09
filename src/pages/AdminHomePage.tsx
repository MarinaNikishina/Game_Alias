import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Select } from '@moysklad/uikit'
import type { HistoryRow } from '../../shared/src/index.ts'
import { adminTokenKey, api } from '../api'

export default function AdminHomePage() {
  const navigate = useNavigate()
  const [teamCount, setTeamCount] = useState<2 | 3>(2)
  const [capacities, setCapacities] = useState<number[]>([4, 4])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<HistoryRow[]>([])

  useEffect(() => {
    api.history().then((res) => setHistory(res.history)).catch(() => setHistory([]))
  }, [])

  useEffect(() => {
    setCapacities((prev) => Array.from({ length: teamCount }, (_, i) => prev[i] ?? 4))
  }, [teamCount])

  async function onCreate() {
    setBusy(true)
    setError('')
    try {
      const result = await api.createGame({ teamCount, capacities })
      localStorage.setItem(adminTokenKey(result.game.id), result.adminToken)
      navigate(`/admin/game/${result.game.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать игру')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <h1 className="app-title">Design Alias</h1>
      <p className="app-subtitle">Администратор создаёт игру и раздаёт ссылку игрокам.</p>

      <section className="panel">
        <h2>Новая игра</h2>
        <div className="row">
          <div className="field">
            <label>Команды</label>
            <Select
              options={[
                { value: 2, label: '2' },
                { value: 3, label: '3' },
              ]}
              value={{ value: teamCount, label: String(teamCount) }}
              onChange={(option) => setTeamCount(option.value as 2 | 3)}
            />
          </div>
          {capacities.map((capacity, index) => (
            <div className="field" key={index}>
              <Input
                name={`capacity-${index}`}
                label={`Мест в команде ${index + 1}`}
                type="number"
                min={1}
                max={20}
                value={capacity}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setCapacities((prev) => prev.map((item, i) => (i === index ? value : item)))
                }}
              />
            </div>
          ))}
          <Button isLoading={busy} onClick={() => void onCreate()}>
            Создать игру
          </Button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>История игр</h2>
        {history.length === 0 ? (
          <p className="muted">Пока нет завершённых игр.</p>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Код</th>
                <th>Команды</th>
                <th>Счёт</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} onClick={() => navigate(`/admin/game/${row.id}`)}>
                  <td>{new Date(row.finishedAt || row.createdAt).toLocaleString('ru-RU')}</td>
                  <td>{row.publicCode}</td>
                  <td>{row.teamNames.join(' / ')}</td>
                  <td>{row.scores.join(' : ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
