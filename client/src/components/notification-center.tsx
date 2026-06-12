/**
 * NEVARA Notification Center — PROD-2
 *
 * Self-contained notification system:
 *   - NotificationProvider  – context + localStorage persistence
 *   - useNotifications()    – hook for pushing/reading notifications
 *   - NotificationBell      – navbar bell with unread badge
 *
 * Categories map to every significant platform event:
 *   project_submitted | verifier_assigned | monitoring_completed |
 *   evidence_generated | report_approved | report_rejected | validation_failed
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import {
  Bell,
  CheckCircle2,
  XCircle,
  Satellite,
  FolderCheck,
  UserCheck,
  FileText,
  AlertTriangle,
  CalendarClock,
  Clock,
  AlarmClock,
  MessageSquare,
  HelpCircle,
  Reply,
  X,
  CheckCheck,
  Trash2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

// ── Types ──────────────────────────────────────────────────────────────────────

export type NotificationCategory =
  | 'project_submitted'
  | 'verifier_assigned'
  | 'monitoring_completed'
  | 'monitoring_due_soon'
  | 'monitoring_due_tomorrow'
  | 'monitoring_overdue'
  | 'monitoring_failed'
  | 'evidence_generated'
  | 'report_approved'
  | 'report_rejected'
  | 'validation_failed'
  | 'review_comment'
  | 'clarification_requested'
  | 'clarification_responded'
  | 'clarification_resolved';

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  timestamp: string; // ISO string for localStorage serialisation
  read: boolean;
  /** Optional link the bell item navigates to */
  href?: string;
}

interface NotificationContextType {
  notifications: AppNotification[];
  unreadCount: number;
  push: (n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);
const STORAGE_KEY = 'nevara_notifications_v1';
const MAX_STORED = 60;

// ── Provider ───────────────────────────────────────────────────────────────────

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setNotifications(JSON.parse(raw));
    } catch {
      // ignore corrupt storage
    }
  }, []);

  // Persist on change (trimmed to MAX_STORED)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, MAX_STORED)));
    } catch {
      // ignore storage quota
    }
  }, [notifications]);

  const push = useCallback((n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => {
    const notification: AppNotification = {
      ...n,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      read: false,
    };
    setNotifications((prev) => [notification, ...prev].slice(0, MAX_STORED));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, push, markRead, markAllRead, clear }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextType {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}

// ── Category metadata ──────────────────────────────────────────────────────────

interface CategoryMeta {
  icon: React.ElementType;
  color: string;        // tailwind text colour
  bg: string;           // tailwind bg colour
  label: string;
}

const CATEGORY_META: Record<NotificationCategory, CategoryMeta> = {
  project_submitted:    { icon: FileText,    color: 'text-sky-400',     bg: 'bg-sky-500/12',    label: 'Submission' },
  verifier_assigned:    { icon: UserCheck,   color: 'text-violet-400',  bg: 'bg-violet-500/12', label: 'Assignment' },
  monitoring_completed: { icon: Satellite,   color: 'text-teal-400',    bg: 'bg-teal-500/12',   label: 'Monitoring' },
  monitoring_due_soon:    { icon: CalendarClock, color: 'text-amber-400', bg: 'bg-amber-500/12', label: 'Due Soon' },
  monitoring_due_tomorrow:{ icon: Clock,         color: 'text-amber-400', bg: 'bg-amber-500/12', label: 'Due Tomorrow' },
  monitoring_overdue:     { icon: AlarmClock,    color: 'text-red-400',   bg: 'bg-red-500/12',   label: 'Overdue' },
  monitoring_failed:      { icon: XCircle,       color: 'text-rose-400',  bg: 'bg-rose-500/12',  label: 'Monitoring Failed' },
  review_comment:          { icon: MessageSquare, color: 'text-sky-400',    bg: 'bg-sky-500/12',    label: 'Discussion' },
  clarification_requested: { icon: HelpCircle,    color: 'text-amber-400',  bg: 'bg-amber-500/12',  label: 'Clarification' },
  clarification_responded: { icon: Reply,         color: 'text-violet-400', bg: 'bg-violet-500/12', label: 'Response' },
  clarification_resolved:  { icon: CheckCircle2,  color: 'text-emerald-400',bg: 'bg-emerald-500/12',label: 'Resolved' },
  evidence_generated:   { icon: FolderCheck, color: 'text-emerald-400', bg: 'bg-emerald-500/12',label: 'Evidence' },
  report_approved:      { icon: CheckCircle2,color: 'text-emerald-400', bg: 'bg-emerald-500/12',label: 'Approved' },
  report_rejected:      { icon: XCircle,     color: 'text-red-400',     bg: 'bg-red-500/12',    label: 'Rejected' },
  validation_failed:    { icon: AlertTriangle,color:'text-amber-400',   bg: 'bg-amber-500/12',  label: 'Alert' },
};

// ── NotificationBell (Navbar widget) ──────────────────────────────────────────

export function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative w-9 h-9 flex items-center justify-center rounded-lg border border-border/50 bg-card hover:bg-muted/60 transition-colors duration-150 focus-ring"
      >
        <Bell className="w-[17px] h-[17px] text-muted-foreground" />
        {unreadCount > 0 && (
          <span
            className="badge-pulse absolute -top-1 -right-1 min-w-[17px] h-[17px] flex items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white px-0.5 select-none"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          ref={panelRef}
          className="anim-slide-down absolute right-0 top-full mt-2 w-[360px] z-[9998] glass-panel rounded-2xl shadow-2xl overflow-hidden"
          style={{ maxHeight: '520px' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Notifications</span>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-500/15 text-red-500 rounded-full">
                  {unreadCount} new
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Mark all read"
                  className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  title="Clear all"
                  className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted/60 text-muted-foreground hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted/60 text-muted-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* List */}
          <div
            className="overflow-y-auto"
            style={{ maxHeight: '440px' }}
          >
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <div className="w-10 h-10 rounded-full bg-muted/40 flex items-center justify-center">
                  <Bell className="w-4 h-4 opacity-40" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">No notifications</p>
                  <p className="text-xs opacity-60 mt-0.5">Platform events will appear here</p>
                </div>
              </div>
            ) : (
              <div>
                {notifications.map((n, i) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    isLast={i === notifications.length - 1}
                    onRead={() => markRead(n.id)}
                    onClose={() => setOpen(false)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Individual notification row ───────────────────────────────────────────────

function NotificationItem({
  notification,
  isLast,
  onRead,
  onClose,
}: {
  notification: AppNotification;
  isLast: boolean;
  onRead: () => void;
  onClose: () => void;
}) {
  const meta = CATEGORY_META[notification.category];
  const Icon = meta.icon;

  const handleClick = () => {
    onRead();
    if (notification.href) {
      window.location.href = notification.href;
      onClose();
    }
  };

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 row-hover cursor-pointer transition-colors
        ${!notification.read ? 'bg-primary/[0.04]' : ''}
        ${!isLast ? 'border-b border-border/30' : ''}
      `}
      onClick={handleClick}
    >
      {/* Unread dot */}
      <div className="relative flex-shrink-0 mt-0.5">
        <div className={`w-8 h-8 rounded-lg ${meta.bg} flex items-center justify-center`}>
          <Icon className={`w-3.5 h-3.5 ${meta.color}`} />
        </div>
        {!notification.read && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary border border-background" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-[12px] font-semibold leading-snug ${notification.read ? 'text-muted-foreground' : 'text-foreground'}`}>
            {notification.title}
          </p>
          <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 tabular-nums whitespace-nowrap mt-0.5">
            {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
          {notification.body}
        </p>
        <span className={`inline-flex items-center gap-1 mt-1 text-[9px] font-semibold uppercase tracking-wider ${meta.color} opacity-75`}>
          {meta.label}
        </span>
      </div>
    </div>
  );
}
