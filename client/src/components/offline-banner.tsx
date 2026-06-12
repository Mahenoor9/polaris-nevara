/**
 * Offline Banner — PROD-2
 * Shows a non-intrusive strip when the browser has no network connectivity.
 */

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const on  = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online',  on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-slate-900 dark:bg-slate-800 border border-white/10 shadow-2xl text-sm font-medium text-white anim-fade-up">
      <WifiOff className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
      <span className="text-[12px]">No internet connection — some data may be unavailable</span>
    </div>
  );
}
