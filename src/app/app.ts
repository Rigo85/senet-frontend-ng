import { Component, DestroyRef, ElementRef, HostListener, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SenetSocketService } from './services/senet-socket.service';
import { MoveRecord, SenetState } from './utils/types';

const LS_KEY = 'senet:gameId';
function resolveBackendUrl(): string {
  // const protocol = window.location.protocol;
  // const hostname = window.location.hostname || 'localhost';
  // return `${protocol}//${hostname}:3008`;
  return  "https://senet-game.rji-services.org";
}

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
type ThrowFx = {
  id: number;
  side: 'HUMAN' | 'BOT';
  sticks: [number, number, number, number];
  value: number;
};
type MoveFx = {
  id: number;
  side: 'HUMAN' | 'BOT';
  icon: string;
  label: string;
  left: number;
  top: number;
  opacity: number;
};
type CaptureFx = {
  id: number;
  left: number;
  top: number;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdown(line: string): string {
  let out = escapeHtml(line);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/`(.+?)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|');
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => renderInlineMarkdown(cell.trim()));
}

function markdownToHtml(md: string): string {
  const lines = md.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    if (trimmed === '---') {
      closeList();
      html.push('<hr/>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^>\s+/.test(trimmed)) {
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s+/, ''))}</blockquote>`);
      continue;
    }

    if (/^- /.test(trimmed)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(trimmed.slice(2))}</li>`);
      continue;
    }

    if (
      i + 1 < lines.length &&
      isTableRow(trimmed) &&
      isTableSeparator(lines[i + 1]?.trim() ?? '')
    ) {
      closeList();
      const headers = parseTableRow(trimmed);
      html.push('<table><thead><tr>');
      for (const h of headers) {
        html.push(`<th>${h}</th>`);
      }
      html.push('</tr></thead><tbody>');

      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseTableRow(lines[i]);
        html.push('<tr>');
        for (const c of cells) {
          html.push(`<td>${c}</td>`);
        }
        html.push('</tr>');
        i += 1;
      }
      html.push('</tbody></table>');
      i -= 1;
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  return html.join('\n');
}

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  @ViewChild('turnLogList') private turnLogList?: ElementRef<HTMLElement>;

  private logSeq = 0;
  private lastMoveTurnSeen = 0;
  private throwFxSeq = 0;
  private throwFxTimer: ReturnType<typeof setTimeout> | null = null;
  private moveFxSeq = 0;
  private moveFxQueue: MoveRecord[] = [];
  private moveFxRunning = false;
  private captureFxSeq = 0;
  private captureFxTimer: ReturnType<typeof setTimeout> | null = null;
  private turnLogScrollPending = false;

  state = signal<SenetState | null>(null);
  loading = signal<boolean>(false);
  message = signal<string>('');
  turnLog = signal<LogEntry[]>([]);
  throwFx = signal<ThrowFx | null>(null);
  moveFx = signal<MoveFx | null>(null);
  captureFx = signal<CaptureFx | null>(null);
  menuOpen = signal<boolean>(false);
  helpModalOpen = signal<boolean>(false);
  helpLoading = signal<boolean>(false);
  helpError = signal<string>('');
  helpMarkdown = signal<string>('');
  helpHtml = signal<string>('');
  selectedDifficulty = signal<2 | 4 | 6>(4);

  boardRows = [
    [1, 20, 21],
    [2, 19, 22],
    [3, 18, 23],
    [4, 17, 24],
    [5, 16, 25],
    [6, 15, 26],
    [7, 14, 27],
    [8, 13, 28],
    [9, 12, 29],
    [10, 11, 30]
  ];

  legalFromPositions = computed(() => {
    const st = this.state();
    if (!st || st.turn !== 'HUMAN' || st.phase !== 'WAIT_MOVE') return new Set<number>();
    return new Set<number>(st.legalMoves.map((m) => m.from));
  });

  showThrowOverlay = computed(() => {
    const st = this.state();
    return !!st && !this.loading() && st.phase === 'WAIT_THROW' && st.turn === 'HUMAN';
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
      this.showThrowFx(payload.side, payload.throw.sticks, payload.throw.value);
    });

    this.ws.onGameOver().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ winner }) => {
      const label = winner === 'HUMAN' ? 'Humano' : 'Bot';
      this.pushNoteEntry(`Fin de partida. Ganador: ${label}`);
      this.message.set(`Juego terminado. Ganador: ${label}`);
    });

    this.ws.onTurnNote().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ message }) => {
      this.pushNoteEntry(message);
    });

    this.destroyRef.onDestroy(() => {
      if (this.throwFxTimer) clearTimeout(this.throwFxTimer);
      if (this.captureFxTimer) clearTimeout(this.captureFxTimer);
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
    this.closeMenu();
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
    this.closeMenu();
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
    if (st.humanPieces.includes(position)) return 'Ra';
    if (st.botPieces.includes(position)) return 'Apophis';
    return '';
  }

  pieceIcon(position: number): string | null {
    const st = this.state();
    if (!st) return null;
    if (st.humanPieces.includes(position)) return '/images/ra.png';
    if (st.botPieces.includes(position)) return '/images/apophis.png';
    return null;
  }

  isClickable(position: number): boolean {
    return this.legalFromPositions().has(position);
  }

  pathTrackClass(position: number): string {
    if (position === 1) return 't-v-down';
    if (position >= 2 && position <= 9) return 't-v-full';
    if (position === 10) return 't-v-up t-h-right';
    if (position === 11) return 't-v-up t-h-left';
    if (position >= 12 && position <= 19) return 't-v-full';
    if (position === 20) return 't-v-down t-h-right';
    if (position === 21) return 't-v-down t-h-left';
    if (position >= 22 && position <= 29) return 't-v-full';
    if (position === 30) return 't-v-up';
    return '';
  }

  specialCellImage(position: number): string | null {
    if (position === 15 || (position >= 26 && position <= 30)) {
      return `/images/casilla-${position}.png`;
    }
    return null;
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

  toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenu();
    this.closeHelpModal();
  }

  async openHowToHelp(): Promise<void> {
    this.helpModalOpen.set(true);
    if (this.helpMarkdown()) return;

    this.helpLoading.set(true);
    this.helpError.set('');
    try {
      const response = await fetch(`${resolveBackendUrl()}/help/how-to-play`);
      if (!response.ok) throw new Error(`http_${response.status}`);
      const markdown = await response.text();
      this.helpMarkdown.set(markdown);
      this.helpHtml.set(markdownToHtml(markdown));
    } catch {
      this.helpError.set('No se pudo cargar la guía desde el backend.');
    } finally {
      this.helpLoading.set(false);
    }
  }

  closeHelpModal(): void {
    this.helpModalOpen.set(false);
  }

  private showThrowFx(side: 'HUMAN' | 'BOT', sticks: [number, number, number, number], value: number): void {
    if (this.throwFxTimer) clearTimeout(this.throwFxTimer);
    this.throwFx.set({
      id: ++this.throwFxSeq,
      side,
      sticks,
      value
    });
    this.throwFxTimer = setTimeout(() => {
      this.throwFx.set(null);
      this.throwFxTimer = null;
    }, 2400);
  }

  private enqueueMoveFx(move: MoveRecord): void {
    this.moveFxQueue.push(move);
    this.runMoveFxQueue();
  }

  private runMoveFxQueue(): void {
    if (this.moveFxRunning) return;
    const next = this.moveFxQueue.shift();
    if (!next) return;
    this.moveFxRunning = true;

    const start = this.getCellCenter(next.from);
    if (!start) {
      this.moveFxRunning = false;
      this.runMoveFxQueue();
      return;
    }

    const end = next.to === 0 ? this.getExitPoint(start) : this.getCellCenter(next.to);
    if (!end) {
      this.moveFxRunning = false;
      this.runMoveFxQueue();
      return;
    }

    const fx: MoveFx = {
      id: ++this.moveFxSeq,
      side: next.side,
      icon: next.side === 'HUMAN' ? '/images/ra.png' : '/images/apophis.png',
      label: next.side === 'HUMAN' ? 'Ra' : 'Apophis',
      left: start.x,
      top: start.y,
      opacity: 1
    };
    this.moveFx.set(fx);

    void this.animateMoveFx(fx.id, start, end, next.to === 0).then(() => {
      this.moveFx.set(null);
      if (next.captures && next.to > 0) this.showCaptureFx(end);
      this.moveFxRunning = false;
      this.runMoveFxQueue();
    });
  }

  private animateMoveFx(
    fxId: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
    fadesOut: boolean
  ): Promise<void> {
    const durationMs = 430;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    const arc = Math.max(10, Math.min(44, distance * 0.25));
    const control = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2 - arc
    };

    return new Promise<void>((resolve) => {
      const startedAt = performance.now();
      const step = (now: number) => {
        const elapsed = now - startedAt;
        const t = Math.min(1, elapsed / durationMs);
        const inv = 1 - t;
        const eased = 1 - Math.pow(1 - t, 3);
        const x = inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x;
        const y = inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y;
        const opacity = fadesOut ? 1 - eased * 0.88 : 1;

        this.moveFx.update((current) => {
          if (!current || current.id !== fxId) return current;
          return { ...current, left: x, top: y, opacity };
        });

        if (t < 1) {
          requestAnimationFrame(step);
          return;
        }
        resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private showCaptureFx(point: { x: number; y: number }): void {
    if (this.captureFxTimer) clearTimeout(this.captureFxTimer);
    this.captureFx.set({
      id: ++this.captureFxSeq,
      left: point.x,
      top: point.y
    });
    this.captureFxTimer = setTimeout(() => {
      this.captureFx.set(null);
      this.captureFxTimer = null;
    }, 320);
  }

  private getBoardWrapElement(): HTMLElement | null {
    return document.querySelector('.board-wrap');
  }

  private getCellCenter(position: number): { x: number; y: number } | null {
    const wrap = this.getBoardWrapElement();
    if (!wrap) return null;
    const cell = wrap.querySelector(`[data-pos="${position}"]`) as HTMLElement | null;
    if (!cell) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    return {
      x: cellRect.left - wrapRect.left + cellRect.width / 2,
      y: cellRect.top - wrapRect.top + cellRect.height / 2
    };
  }

  private getExitPoint(from: { x: number; y: number }): { x: number; y: number } | null {
    const wrap = this.getBoardWrapElement();
    if (!wrap) return null;
    const wrapRect = wrap.getBoundingClientRect();
    return {
      x: from.x,
      y: Math.max(10, from.y - Math.min(86, wrapRect.height * 0.28))
    };
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
    this.requestTurnLogScrollToEnd();
  }

  private pushNoteEntry(message: string): void {
    const entry: NoteLogEntry = {
      kind: 'note',
      id: ++this.logSeq,
      message
    };
    this.turnLog.update((current) => [...current, entry].slice(-120));
    this.requestTurnLogScrollToEnd();
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
      this.enqueueMoveFx(mv);
    }
    this.requestTurnLogScrollToEnd();
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
    this.requestTurnLogScrollToEnd();
  }

  private requestTurnLogScrollToEnd(): void {
    if (this.turnLogScrollPending) return;
    this.turnLogScrollPending = true;
    queueMicrotask(() => {
      this.turnLogScrollPending = false;
      const el = this.turnLogList?.nativeElement;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
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
