import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useOperatorTerminalSession } from '~/lib/hooks/useOperatorTerminalSession';

export interface OperatorTerminalViewProps {
  apiUrl: string;
  resourcePath: string;
  token: string;
  title?: string;
  subtitle?: string;
  initialCwd?: string;
  displayUsername?: string;
  displayPath?: string;
}

const theme = {
  background: '#0c0c0e',
  foreground: '#d4d4d8',
  cursor: '#34d399',
  cursorAccent: '#0c0c0e',
  selectionBackground: '#0f766e55',
  selectionForeground: '#d4d4d8',
  black: '#18181b',
  red: '#ef4444',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#14b8a6',
  cyan: '#22d3ee',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#5eead4',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const INPUT_FLUSH_DELAY_MS = 25;
const BANNER_WIDTH = 45;

export function OperatorTerminalView({
  apiUrl,
  resourcePath,
  token,
  title = 'Bot Shell',
  subtitle = 'Secure shell via operator relay',
  initialCwd = '',
  displayUsername = '',
  displayPath = '',
}: OperatorTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const isConnectedRef = useRef(false);
  const pendingInputRef = useRef('');
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [terminalSize, setTerminalSize] = useState<{ cols: number; rows: number } | null>(null);

  const formatBannerLine = useCallback((value: string) => {
    const normalized = value.trim();
    if (!normalized) return ''.padEnd(BANNER_WIDTH);
    if (normalized.length <= BANNER_WIDTH) return normalized.padEnd(BANNER_WIDTH);
    return `${normalized.slice(0, BANNER_WIDTH - 3)}...`;
  }, []);

  const writeBanner = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    const bannerLines = [
      formatBannerLine(title),
      formatBannerLine(subtitle),
      displayUsername ? formatBannerLine(`User: ${displayUsername}`) : '',
      displayPath ? formatBannerLine(`Start dir: ${displayPath}`) : '',
    ].filter(Boolean);

    term.writeln(`+${'-'.repeat(BANNER_WIDTH + 2)}+`);
    bannerLines.forEach((line, index) => {
      const content = index === 0 ? `\x1b[1m${line}\x1b[0m` : line;
      term.writeln(`| ${content} |`);
    });
    term.writeln(`+${'-'.repeat(BANNER_WIDTH + 2)}+`);
  }, [displayPath, displayUsername, formatBannerLine, subtitle, title]);

  const handleOutput = useCallback((data: string) => {
    if (!data) return;
    termRef.current?.write(data);
  }, []);

  const { isConnected, error, sendInput, reconnect, newSession } = useOperatorTerminalSession({
    apiUrl,
    resourcePath,
    token,
    initialCwd,
    terminalSize,
    onOutput: handleOutput,
  });

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  const handleNewSession = useCallback(() => {
    const term = termRef.current;
    if (term) {
      term.reset();
      writeBanner();
    }
    pendingInputRef.current = '';
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = undefined;
    }
    newSession();
  }, [newSession, writeBanner]);

  const syncTerminalSize = useCallback((term: Terminal, fitAddon: FitAddon) => {
    fitAddon.fit();
    setTerminalSize((current) => {
      if (current?.cols === term.cols && current?.rows === term.rows) {
        return current;
      }
      return { cols: term.cols, rows: term.rows };
    });
  }, []);

  const flushPendingInput = useCallback(() => {
    inputFlushTimerRef.current = undefined;
    const data = pendingInputRef.current;
    if (!data || !isConnectedRef.current) {
      pendingInputRef.current = '';
      return;
    }
    pendingInputRef.current = '';
    const term = termRef.current;
    sendInput(data).catch((err) => {
      term?.writeln(`\r\nError: ${err instanceof Error ? err.message : String(err)}\r\n`);
    });
  }, [sendInput]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      syncTerminalSize(term, fitAddon);
    });

    termRef.current = term;
    writeBanner();

    term.onData((data) => {
      if (!isConnectedRef.current) {
        return;
      }
      pendingInputRef.current += data;
      if (inputFlushTimerRef.current) {
        return;
      }
      inputFlushTimerRef.current = setTimeout(flushPendingInput, INPUT_FLUSH_DELAY_MS);
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        syncTerminalSize(term, fitAddon);
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (inputFlushTimerRef.current) {
        clearTimeout(inputFlushTimerRef.current);
        inputFlushTimerRef.current = undefined;
      }
      pendingInputRef.current = '';
      term.dispose();
      termRef.current = null;
    };
  }, [flushPendingInput, syncTerminalSize, writeBanner]);

  return (
    <div className="relative h-[560px] w-full group">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden rounded-xl border border-arena-elements-borderColor/70 shadow-[0_20px_80px_rgba(0,0,0,0.35)]"
        style={{ backgroundColor: theme.background }}
      />

      {isConnected && (
        <button
          onClick={handleNewSession}
          className="absolute top-3 right-3 flex items-center gap-1.5 rounded-md bg-neutral-800/85 px-2.5 py-1.5 text-xs text-neutral-300 opacity-0 transition-opacity hover:bg-neutral-700/85 hover:text-neutral-50 group-hover:opacity-100"
          type="button"
        >
          <span className="i-ph:arrows-clockwise text-sm" />
          New session
        </button>
      )}

      {!isConnected && !error && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-md bg-neutral-800/85 px-2.5 py-1.5 text-xs text-neutral-300">
          <span className="i-ph:spinner-gap animate-spin text-sm" />
          Connecting...
        </div>
      )}

      {error && (
        <div className="absolute inset-x-4 bottom-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <button
              onClick={reconnect}
              className="rounded-md border border-red-500/30 px-2 py-1 text-xs hover:bg-red-500/10"
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
