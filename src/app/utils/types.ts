export type Player = 'HUMAN' | 'BOT';

export type MoveKind = 'forward_exact' | 'backward_exact' | 'backward_fallback';

export interface StickThrow {
  sticks: [number, number, number, number];
  whiteCount: number;
  value: 1 | 2 | 3 | 4 | 6;
}

export interface SenetMove {
  from: number;
  to: number;
  kind: MoveKind;
  captures: boolean;
  exitsBoard?: boolean;
}

export interface MoveRecord {
  turn: number;
  side: Player;
  roll: number;
  from: number;
  to: number;
  kind: MoveKind;
  captures: boolean;
  exitsBoard: boolean;
}

export interface SenetState {
  __typename: 'SenetState';
  id: string;
  version: number;
  phase: 'WAIT_THROW' | 'WAIT_MOVE' | 'GAME_OVER';
  turn: Player;
  humanPieces: number[];
  botPieces: number[];
  exitedHuman: number;
  exitedBot: number;
  pendingThrow: StickThrow | null;
  legalMoves: SenetMove[];
  moveHistory: MoveRecord[];
  winner: Player | null;
  difficulty: 2 | 4 | 6;
  extraTurnChain: boolean;
}
