import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ── Error parsing ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new ApiError(res.status, `${res.status}: ${text}`);
  }
}

// ── Auth token helper ─────────────────────────────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('bluecarbon_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Core request wrapper ──────────────────────────────────────────────────────

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { ...getAuthHeaders() };

  if (data && !(data instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: data instanceof FormData ? data : (data ? JSON.stringify(data) : undefined),
  });

  await throwIfResNotOk(res);
  return res;
}

// ── Smart retry logic ─────────────────────────────────────────────────────────
// Never retry on 4xx (client errors) — only retry transient server errors.

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    // Don't retry client errors: 4xx except 429 (rate limit)
    if (error.status >= 400 && error.status < 500 && error.status !== 429) return false;
    // Retry server errors up to 2 times
    if (error.status >= 500) return failureCount < 2;
  }
  // Network errors (no response) — retry once
  if (error instanceof TypeError) return failureCount < 1;
  return false;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 8000);
}

// ── Query function ─────────────────────────────────────────────────────────────

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;

    try {
      const res = await fetch(url, { headers: getAuthHeaders() });

      if (res.status === 401) {
        if (unauthorizedBehavior === "returnNull") return null;
        // Expired/invalid token — clear local storage and reload to login
        localStorage.removeItem('bluecarbon_token');
        localStorage.removeItem('bluecarbon_user');
        window.location.href = '/login';
        throw new ApiError(401, 'Session expired. Redirecting to login…');
      }

      await throwIfResNotOk(res);
      return await res.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Wrap network errors with context
      const msg = error instanceof Error ? error.message : String(error);
      throw new TypeError(`Network request failed for ${url}: ${msg}`);
    }
  };

// ── QueryClient ───────────────────────────────────────────────────────────────

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // 2-minute stale time — prevents hammering the server on every navigation
      staleTime: 2 * 60 * 1000,
      // 10-minute garbage-collect window — evicts unused entries before they cause stale renders
      gcTime: 10 * 60 * 1000,
      retry: shouldRetry,
      retryDelay,
      // Don't throw for 404s — components can handle undefined data
      throwOnError: (error) => {
        if (error instanceof ApiError && error.status === 404) return false;
        return true;
      },
    },
    mutations: {
      retry: (failureCount, error) => {
        // Retry mutations only on 503 Service Unavailable, once
        if (error instanceof ApiError && error.status === 503) return failureCount < 1;
        return false;
      },
    },
  },
});

// ── Network offline detection ─────────────────────────────────────────────────
// Pause/resume React Query when the browser goes offline/online.

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    queryClient.cancelQueries();
  });
  window.addEventListener('online', () => {
    queryClient.invalidateQueries();
  });
}
