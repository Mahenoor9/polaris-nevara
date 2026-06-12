import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { LogOut, Moon, Sun, Settings } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { NotificationBell } from '@/components/notification-center';

export function Navbar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const { data: stats } = useQuery<{ totalCO2Captured: number; totalAreaHa?: number }>({
    queryKey: ['/api/stats'],
    enabled: !!user,
    refetchInterval: 10000,
  });

  const handleLogout = () => {
    logout();
    window.location.href = '/';
  };

  const getDashboardLink = () => {
    if (!user) return '/';
    switch (user.role) {
      case 'admin':
      case 'verifier':
        return '/operations';
      default:
        return '/dashboard';
    }
  };

  const getUserDisplayName = () => {
    if (!user) return 'User';
    return user.name || user.email || 'User';
  };

  const getUserInitials = () => {
    const displayName = getUserDisplayName();
    return displayName.substring(0, 2).toUpperCase();
  };

  const navLinks = [
    ...(user ? [{ href: getDashboardLink(), label: 'Dashboard' }] : []),
  ];

  return (
    <nav className="sticky top-0 z-50 w-full border-b backdrop-blur-md bg-background/80">
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <Link href={user ? getDashboardLink() : '/'}>
          <span className="flex items-center gap-2.5 hover-elevate rounded-md px-3 py-2 transition-all cursor-pointer" data-testid="link-home">
            <img src="/nivara-ring-logo.png" alt="NEVARA Icon" className="w-8 h-8 object-contain" />
            <span className="font-heading text-xl font-bold tracking-tight">NEVARA</span>
          </span>
        </Link>

        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-4">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href}>
                <span
                  className={`text-sm font-medium transition-colors hover:text-primary cursor-pointer ${location === link.href ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  data-testid={`link-${link.label.toLowerCase()}`}
                >
                  {link.label}
                </span>
              </Link>
            ))}
          </div>

          {user && stats?.totalAreaHa !== undefined && stats.totalAreaHa > 0 && (
            <Badge variant="secondary" className="hidden md:flex gap-1" data-testid="badge-area-counter">
              <img src="/nivara-ring-logo.png" alt="" className="w-3 h-3 opacity-70" />
              {stats.totalAreaHa.toLocaleString(undefined, { maximumFractionDigits: 0 })} ha monitored
            </Badge>
          )}

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            data-testid="button-theme-toggle"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>

          {user && <NotificationBell />}

          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" data-testid="button-user-menu">
                  <Avatar className="w-8 h-8">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                      {getUserInitials()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>
                  <div className="flex items-center gap-2.5 py-0.5">
                    <Avatar className="w-8 h-8">
                      <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                        {getUserInitials()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col min-w-0">
                      <span className="font-semibold text-sm truncate">{getUserDisplayName()}</span>
                      <span className="text-[10px] text-muted-foreground capitalize font-medium tracking-wide">
                        {user.role === 'admin' ? '⬡ Administrator' : user.role === 'verifier' ? '✦ Verifier' : '◆ Contributor'}
                      </span>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} data-testid="button-logout" className="text-muted-foreground hover:text-destructive focus:text-destructive">
                  <LogOut className="w-3.5 h-3.5 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </nav>
  );
}
