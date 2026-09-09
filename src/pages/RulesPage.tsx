import { Link, useParams } from 'react-router-dom'
import { Button } from '@moysklad/uikit'

export default function RulesPage() {
  const { gameId = '' } = useParams()

  return (
    <div className="app-shell">
      <h1 className="app-title">Как играть</h1>
      <section className="panel">
        <p>
          У каждого игрока — <strong>один раунд длительностью 2 минуты</strong>.
        </p>
        <p>
          Когда наступит ваш ход, нажмите <strong>«Начать раунд»</strong> и объясняйте слова своей
          команде.
        </p>
        <p>При объяснении нельзя называть:</p>
        <ul>
          <li>само слово;</li>
          <li>однокоренные слова;</li>
          <li>это слово на другом языке.</li>
        </ul>
        <p>
          <strong>Угадали</strong> — +1 очко команде.
          <br />
          <strong>Пропустить</strong> — 0 очков.
        </p>
        <p>После каждого ответа сразу появится новое слово.</p>
        <p>
          Когда основное время закончится, у вас будет ещё <strong>5 секунд</strong>, чтобы отметить
          результат последнего слова.
        </p>
        <p>
          Порядок ходов определяет система. Следите за очередью и ждите, когда ход будет назначен
          вам.
        </p>
        <p>Побеждает команда, которая наберёт больше всего очков.</p>
        <Link to={`/game/${gameId}`}>
          <Button>К игре</Button>
        </Link>
      </section>
    </div>
  )
}
