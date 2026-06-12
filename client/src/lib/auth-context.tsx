import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { User } from '@shared/schema';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (user: User, token: string) => void;
  updateUser: (user: User) => void;
  refreshUser: () => Promise<void>;
  logout: (reason?: string) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_KEY  = 'bluecarbon_user';
const TOKEN_KEY = 'bluecarbon_token';

// ── JWT expiry check (client-side, without library) ───────────────────────────

function isTokenExpired(token: string): boolean {
  try {
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(atob(payloadB64));
    if (!payload.exp) return false;
    // Add 30s clock skew tolerance
    return Date.now() / 1000 > payload.exp - 30;
  } catch {
    return true; // malformed token → treat as expired
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<User | null>(null);
  const [token, setToken]     = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback((reason?: string) => {
    setUser(null);
    setToken(null);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (reason === 'expired') {
      // Brief wait so state clears before navigation
      setTimeout(() => { window.location.href = '/login?reason=session_expired'; }, 50);
    }
  }, []);

  // Hydrate from localStorage on mount — validate token before accepting it
  useEffect(() => {
    const storedUser  = localStorage.getItem(USER_KEY);
    const storedToken = localStorage.getItem(TOKEN_KEY);

    if (storedToken && storedUser && storedUser !== 'undefined' && storedUser !== 'null') {
      if (isTokenExpired(storedToken)) {
        // Token is expired — clear silently, let login page handle it
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
      } else {
        try {
          setUser(JSON.parse(storedUser));
          setToken(storedToken);
        } catch {
          localStorage.removeItem(USER_KEY);
          localStorage.removeItem(TOKEN_KEY);
        }
      }
    }

    setIsLoading(false);
  }, [logout]);

  // Proactive expiry check every 5 minutes while tab is open
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      if (isTokenExpired(token)) logout('expired');
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token, logout]);

  const login = useCallback((u: User, t: string) => {
    setUser(u);
    setToken(t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    localStorage.setItem(TOKEN_KEY, t);
  }, []);

  const updateUser = useCallback((updatedUser: User) => {
    setUser(updatedUser);
    localStorage.setItem(USER_KEY, JSON.stringify(updatedUser));
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    try {
      const { apiRequest } = await import('./queryClient');
      const response = await apiRequest('GET', '/api/auth/profile');
      if (response.ok) {
        const updatedUser: User = await response.json();
        updateUser(updatedUser);
      }
    } catch (error: any) {
      // 401 → session expired
      if (error?.status === 401) logout('expired');
    }
  }, [token, updateUser, logout]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        updateUser,
        refreshUser,
        logout,
        isAuthenticated: !!user && !!token,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
