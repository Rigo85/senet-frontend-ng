import { Component, DestroyRef, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SenetSocketService } from './services/senet-socket.service';
import { MoveRecord, SenetState } from './utils/types';

const LS_KEY = 'senet:gameId';

type TurnLogEntry = {
  kind: 'turn';
  id: number;
  side: 'HUMAN' | 'BOT';
  sticks: [number, number, number, number] | null;
  roll: number;
  movement: string | null;
  repeatNote: string | null;
};

type NoteLogEntry = {
  kind: 'note';
  id: number;
  message: string;
};

type LogEntry = TurnLogEntry | NoteLogEntry;

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private logSeq = 0;
  private lastMoveTurnSeen = 0;

  state = signal<SenetState | null>(null);
  loading = signal<boolean>(false);
  message = signal<string>('');
  turnLog = signal<LogEntry[]>([]);
  selectedDifficulty = signal<2 | 4 | 6>(4);

  boardRows = [
    [1,2,3,4,5,6,7,8,9,10],
    [20,19,18,17,16,15,14,13,12,11],
    [21,22,23,24,25,26,27,28,29,30]
  ];

  legalFromPositions = computed(() => {
    const st = this.state();
    if (!st || st.turn !== 'HUMAN' || st.phase !== 'WAIT_MOVE') return new Set<number>();
    return new Set<number>(st.legalMoves.map((m) => m.from));
  });

  constructor(private ws: SenetSocketService, private destroyRef: DestroyRef) {
    this.ws.onState().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((st) => {
      this.state.set(st);
      this.loading.set(false);
      this.message.set('');
      this.selectedDifficulty.set(st.difficulty);
      this.persistGameId(st.id);

      // If page was refreshed, we may have move history but no prior throws in local UI.
      if (this.turnLog().length === 0 && st.moveHistory.length > 0) {
        this.seedLogFromMoveHistory(st.moveHistory);
      }

      this.pushNewMovesToLog(st);
    });

    this.ws.onThrowResult().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((payload) => {
      this.pushTurnEntry(payload.side, payload.throw.sticks, payload.throw.value);
    });

    this.ws.onGameOver().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ winner }) => {
      const label = winner === 'HUMAN' ? 'Humano' : 'Bot';
      this.pushNoteEntry(`Fin de partida. Ganador: ${label}`);
      this.message.set(`Juego terminado. Ganador: ${label}`);
    });

    this.ws.onTurnNote().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ message }) => {
      this.pushNoteEntry(message);
    });

    void this.bootstrapGame();
  }

  private async runAction(action: () => Promise<void>, errorMessage: string): Promise<void> {
    this.loading.set(true);
    try {
      await action();
    } catch (err: any) {
      this.message.set(`${errorMessage} (${err?.message ?? 'error'})`);
      this.loading.set(false);
    }
  }

  private async bootstrapGame(): Promise<void> {
    this.message.set('Cargando partida...');
    this.loading.set(true);

    const saved = this.readGameId();
    await this.runAction(async () => {
      if (saved) {
        try {
          await this.ws.join(saved);
          return;
        } catch {
          // If saved game does not exist anymore, create a new one.
        }
      }
      await this.ws.gameNew(undefined, this.selectedDifficulty());
    }, 'No se pudo cargar la partida');
  }

  async onNewGame(): Promise<void> {
    await this.runAction(async () => {
      this.turnLog.set([]);
      this.lastMoveTurnSeen = 0;
      await this.ws.gameNew(undefined, this.selectedDifficulty());
    }, 'No se pudo crear una nueva partida');
  }

  async onThrow(): Promise<void> {
    const st = this.state();
    if (!st || st.phase !== 'WAIT_THROW' || st.turn !== 'HUMAN') return;
    await this.runAction(async () => {
      await this.ws.throwSticks(st.id);
    }, 'No se pudo lanzar las tablillas');
  }

  async onCellClick(position: number): Promise<void> {
    const st = this.state();
    if (!st || st.phase !== 'WAIT_MOVE' || st.turn !== 'HUMAN') return;
    if (!this.legalFromPositions().has(position)) return;
    await this.runAction(async () => {
      await this.ws.playMove(st.id, position);
    }, 'No se pudo ejecutar el movimiento');
  }

  async onDifficultyChange(value: string): Promise<void> {
    const parsed = Number(value) as 2 | 4 | 6;
    this.selectedDifficulty.set(parsed);
    const st = this.state();
    if (!st) return;
    await this.runAction(async () => {
      await this.ws.changeDifficulty(st.id, parsed);
    }, 'No se pudo cambiar la dificultad');
  }

  pieceClass(position: number): string {
    const st = this.state();
    if (!st) return 'cell';
    if (st.humanPieces.includes(position)) return 'cell piece-human';
    if (st.botPieces.includes(position)) return 'cell piece-bot';
    return 'cell';
  }

  pieceLabel(position: number): string {
    const st = this.state();
    if (!st) return '';
    if (st.humanPieces.includes(position)) return 'H';
    if (st.botPieces.includes(position)) return 'B';
    return '';
  }

  isClickable(position: number): boolean {
    return this.legalFromPositions().has(position);
  }

  sideLabel(side: 'HUMAN' | 'BOT'): string {
    return side === 'HUMAN' ? 'Humano' : 'Bot';
  }

  sticksLabel(sticks: [number, number, number, number] | null): string {
    if (!sticks) return '(sin detalle)';
    return sticks.map((v) => `[${v === 1 ? '□' : '■'}]`).join('');
  }

  logIndex(index: number): number {
    return index + 1;
  }

  private moveLabel(record: MoveRecord): string {
    const to = record.to === 0 ? 'OUT' : String(record.to);
    let suffix = '';
    if (record.exitsBoard) suffix = ' (sale)';
    else if (record.captures) suffix = ' (captura)';
    else if (record.kind === 'backward_exact') suffix = ' (retroceso exacto)';
    else if (record.kind === 'backward_fallback') suffix = ' (retroceso fallback)';

    return `${record.from} ► ${to}${suffix}`;
  }

  private pushTurnEntry(side: 'HUMAN' | 'BOT', sticks: [number, number, number, number], roll: number): void {
    let streak = 1;
    for (let i = this.turnLog().length - 1; i >= 0; i -= 1) {
      const prev = this.turnLog()[i];
      if (prev.kind !== 'turn') continue;
      if (prev.side !== side) break;
      if (prev.roll === roll) {
        streak += 1;
        continue;
      }
      break;
    }

    const repeatByRule = roll === 1 || roll === 3 || roll === 6;
    let repeatNote: string | null = null;
    if (repeatByRule) {
      repeatNote = `Repite jugada por valor ${roll}.`;
      if (streak > 1) {
        repeatNote += ` Valor ${roll} repetido ${streak} veces seguidas.`;
      }
    } else if (streak > 1) {
      repeatNote = `Valor ${roll} repetido ${streak} veces seguidas.`;
    }

    const entry: TurnLogEntry = {
      kind: 'turn',
      id: ++this.logSeq,
      side,
      sticks,
      roll,
      movement: null,
      repeatNote
    };
    this.turnLog.update((current) => [...current, entry].slice(-120));
  }

  private pushNoteEntry(message: string): void {
    const entry: NoteLogEntry = {
      kind: 'note',
      id: ++this.logSeq,
      message
    };
    this.turnLog.update((current) => [...current, entry].slice(-120));
  }

  private pushNewMovesToLog(state: SenetState): void {
    const fresh = state.moveHistory.filter((m) => m.turn > this.lastMoveTurnSeen);
    if (fresh.length === 0) return;

    for (const mv of fresh) {
      const movement = this.moveLabel(mv);
      let matched = false;

      this.turnLog.update((current) => {
        const next = [...current];
        const idx = next.findIndex(
          (entry) => entry.kind === 'turn' && entry.side === mv.side && entry.roll === mv.roll && entry.movement == null
        );

        if (idx >= 0) {
          const base = next[idx] as TurnLogEntry;
          next[idx] = { ...base, movement };
          matched = true;
          return next;
        }

        return next;
      });

      if (!matched) {
        const synthetic: TurnLogEntry = {
          kind: 'turn',
          id: ++this.logSeq,
          side: mv.side,
          sticks: null,
          roll: mv.roll,
          movement,
          repeatNote: null
        };
        this.turnLog.update((current) => [...current, synthetic].slice(-120));
      }

      this.lastMoveTurnSeen = Math.max(this.lastMoveTurnSeen, mv.turn);
    }
  }

  private seedLogFromMoveHistory(moveHistory: MoveRecord[]): void {
    const seeded: TurnLogEntry[] = moveHistory.map((mv) => ({
      kind: 'turn',
      id: ++this.logSeq,
      side: mv.side,
      sticks: null,
      roll: mv.roll,
      movement: this.moveLabel(mv),
      repeatNote: null
    }));
    this.turnLog.set(seeded.slice(-120));
    this.lastMoveTurnSeen = moveHistory.length;
  }

  private readGameId(): string | null {
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  }

  private persistGameId(id: string): void {
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {
      // ignore
    }
  }
}
