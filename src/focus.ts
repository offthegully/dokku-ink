// Terminal focus tracking via xterm focus reporting (DEC mode 1004).
//
// With the mode on, the terminal sends ESC[I when its window gains focus and
// ESC[O when it loses it. iTerm2, Ghostty, Kitty, WezTerm, Alacritty, VS
// Code, Windows Terminal and tmux (`set -g focus-events on`) all support it;
// terminals that don't simply never send the sequences, so we stay "focused"
// and nothing changes. The sequences arrive on stdin mixed in with keys, so
// they have to be stripped before Ink sees them — otherwise they'd land in
// the `:` prompt as literal "[I" / "[O" text.

const FOCUS_RE = /\u001B\[([IO])/g;

let focused = true;
const listeners = new Set<(focused: boolean) => void>();

export function isFocused(): boolean {
  return focused;
}

/** Subscribe to focus changes; returns an unsubscribe function. */
export function onFocusChange(fn: (focused: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setFocused(next: boolean): void {
  if (next === focused) return;
  focused = next;
  for (const fn of listeners) fn(next);
}

/** Remove focus sequences from a stdin chunk, applying the last one seen.
 *  Exported for tests. */
export function stripFocus(chunk: string): string {
  let last: string | null = null;
  const rest = chunk.replace(FOCUS_RE, (_m, dir: string) => {
    last = dir;
    return '';
  });
  if (last !== null) setFocused(last === 'I');
  return rest;
}

/**
 * Wrap stdin so Ink's `read()` loop never sees focus sequences. A chunk that
 * was nothing but a focus event is skipped rather than handed over empty
 * (Ink would treat '' as a keypress).
 */
export function focusAwareStdin(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === 'read') {
        return (...args: unknown[]) => {
          for (;;) {
            const chunk = (target.read as (...a: unknown[]) => unknown)(...args);
            if (typeof chunk !== 'string') return chunk; // null (drained) or a Buffer
            const rest = stripFocus(chunk);
            if (rest !== '') return rest;
          }
        };
      }
      const value = target[prop as keyof typeof target];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as NodeJS.ReadStream;
}

/** Turn focus reporting on; returns a function that turns it back off. */
export function enableFocusReporting(stdout: NodeJS.WriteStream): () => void {
  stdout.write('\u001B[?1004h');
  let off = false;
  return () => {
    if (off) return;
    off = true;
    stdout.write('\u001B[?1004l');
  };
}
