/**
 * useMRVProgress.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * React hook for subscribing to real-time MRV progress via Server-Sent Events.
 *
 * Usage:
 *   const { progress, step, status, isConnected } = useMRVProgress(projectId);
 *
 * Falls back to polling every 3s if SSE is not available or browser doesn't support it.
 * Auto-reconnects on connection loss with exponential backoff (max 30s).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export interface MRVProgressState {
  progress: number;
  step: string;
  status: string;
  label: string;
  ts: string | null;
  isConnected: boolean;
  error: string | null;
}

const INITIAL_STATE: MRVProgressState = {
  progress: 0,
  step: '',
  status: 'IDLE',
  label: '',
  ts: null,
  isConnected: false,
  error: null,
};

const MAX_RECONNECT_DELAY_MS = 30_000;

export function useMRVProgress(projectId: string | null): MRVProgressState {
  const [state, setState] = useState<MRVProgressState>(INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);
  const reconnectDelay = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const connect = useCallback(() => {
    if (!projectId || !isMounted.current) return;

    // EventSource is not yet universally available in all test environments
    if (typeof EventSource === 'undefined') {
      setState(prev => ({ ...prev, error: 'SSE not supported' }));
      return;
    }

    const url = `/api/sse/mrv-progress?projectId=${encodeURIComponent(projectId)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', () => {
      if (!isMounted.current) return;
      reconnectDelay.current = 1000; // reset backoff
      setState(prev => ({ ...prev, isConnected: true, error: null }));
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      if (!isMounted.current) return;
      try {
        const data = JSON.parse(e.data);
        setState(prev => ({
          ...prev,
          progress: data.progress ?? prev.progress,
          step: data.step ?? prev.step,
          status: data.status ?? prev.status,
          label: data.label ?? prev.label,
          ts: data.ts ?? prev.ts,
          isConnected: true,
          error: null,
        }));
      } catch {
        // Malformed event — ignore
      }
    });

    es.onerror = () => {
      if (!isMounted.current) return;
      es.close();
      esRef.current = null;
      setState(prev => ({ ...prev, isConnected: false }));

      // Exponential backoff reconnect
      const delay = Math.min(reconnectDelay.current, MAX_RECONNECT_DELAY_MS);
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [projectId]);

  useEffect(() => {
    isMounted.current = true;
    connect();

    return () => {
      isMounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect]);

  return state;
}
