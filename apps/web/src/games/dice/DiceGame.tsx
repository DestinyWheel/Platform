import type { GameProps } from '../registry';

interface DiceData {
  scores: Record<string, number>;
  roundRolls: Record<string, number | null>;
  rounds: number;
  last: { player: string; value: number } | null;
}

const DICE_FACE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export function DiceGame({ view, you, playerNames, legal, onAction }: GameProps) {
  const data = view.data as unknown as DiceData;
  const canRoll = legal.includes('roll');
  const champions = (view.ranking?.[0] ?? []).map((id) => playerNames[id] ?? id).join('、');

  return (
    <div className="dice">
      <div className="dice-round">
        第 {view.round} / {data.rounds} 轮
      </div>

      <div className="dice-players">
        {view.players.map((player) => {
          const roll = data.roundRolls[player] ?? null;
          const classes = ['dice-player'];
          if (view.turn === player) classes.push('active');
          if (player === you) classes.push('me');
          return (
            <div key={player} className={classes.join(' ')}>
              <div className="dice-name">{playerNames[player] ?? player}</div>
              <div className={`dice-face ${roll ? 'rolled' : ''}`} key={`${player}-${roll}`}>
                {roll ? DICE_FACE[roll - 1] : '·'}
              </div>
              <div className="dice-score">{data.scores[player] ?? 0}</div>
            </div>
          );
        })}
      </div>

      {view.finished ? (
        <div className="dice-result">🏆 {champions}</div>
      ) : (
        <button className="primary big" disabled={!canRoll} onClick={() => onAction('roll')}>
          {canRoll ? '掷骰子' : '等待对手…'}
        </button>
      )}
    </div>
  );
}
