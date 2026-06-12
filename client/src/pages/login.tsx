import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Waves, LogIn, UserPlus, Building2, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from '@shared/schema';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { PixelTrailBackground } from '@/components/ui/pixel-trail-background';


// Development-only credential shortcuts — never rendered in production
const DEV_ACCOUNTS = [
  { email: 'admin@bluecarbon.com', password: 'admin123', portal: 'Operations', label: 'admin@bluecarbon.com / admin123' },
  { email: 'verifier1@bluecarbon.com', password: 'verifier123', portal: 'Operations', label: 'verifier1@bluecarbon.com / verifier123' },
  { email: 'alice@bluecarbon.com', password: 'password123', portal: 'Organisation', label: 'alice@bluecarbon.com / password123' },
];

const REDIRECT_MAP = { admin: '/operations', verifier: '/operations', contributor: '/dashboard' } as const;

function dest(role: string) {
  return REDIRECT_MAP[role as keyof typeof REDIRECT_MAP] ?? '/dashboard';
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, user, isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'login' | 'signup'>('login');
  const [devOpen, setDevOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated && user) {
      setLocation(dest(user.role));
    }
  }, [isLoading, isAuthenticated, user, setLocation]);

  // Show a session-expired notice if redirected here after token expiry
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reason') === 'session_expired') {
      toast({
        title: 'Session expired',
        description: 'Your session has expired. Please sign in again to continue.',
        variant: 'destructive',
      });
      // Clean the URL so the banner doesn't show on refresh
      window.history.replaceState({}, '', '/login');
    }
  }, [toast]);

  const loginForm = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const signupForm = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', role: 'contributor' },
  });

  const loginMutation = useMutation({
    mutationFn: async (data: LoginInput) => {
      const res = await apiRequest('POST', '/api/auth/login', data);
      return await res.json();
    },
    onSuccess: (data: any) => {
      login(data.user, data.token);
      toast({ title: data.message || 'Welcome back!', description: `Logged in as ${data.user.name}` });
      setTimeout(() => setLocation(dest(data.user.role)), 100);
    },
    onError: (error: any) => {
      toast({ variant: 'destructive', title: 'Login failed', description: error.message || 'Invalid credentials' });
    },
  });

  const signupMutation = useMutation({
    mutationFn: async (data: SignupInput) => {
      const res = await apiRequest('POST', '/api/auth/signup', data);
      return await res.json();
    },
    onSuccess: (data: any) => {
      login(data.user, data.token);
      toast({ title: data.message || 'Account created!', description: 'Welcome to NEVARA' });
      setTimeout(() => setLocation(dest(data.user.role)), 100);
    },
    onError: (error: any) => {
      toast({ variant: 'destructive', title: 'Signup failed', description: error.message || 'Could not create account' });
    },
  });

  const fillDev = (email: string, password: string) => {
    loginForm.setValue('email', email);
    loginForm.setValue('password', password);
    setActiveTab('login');
  };

  return (
    <div className="relative overflow-hidden">
      <PixelTrailBackground className="absolute inset-0 -z-10" />

      <div className="min-h-screen flex items-center justify-center p-4 sm:p-8 relative z-10">
        <div className="w-full max-w-6xl grid md:grid-cols-2 gap-10 lg:gap-16 items-center">

          {/* ── Left panel — product messaging ───────────────────────────── */}
          <div className="text-center md:text-left space-y-8 text-white">
            <div>
              <div className="flex items-center justify-center md:justify-start gap-3 mb-4">
                <img src="/nivara-ring-logo.png" alt="NEVARA" className="w-12 h-12 object-contain" />
                <span className="text-4xl md:text-5xl font-heading font-bold tracking-tight">NEVARA</span>
              </div>
              <p className="text-lg md:text-xl text-white/80 font-medium leading-snug">
                Ecological Monitoring, Reporting &amp; Verification
              </p>
            </div>

            <div className="space-y-4">
              {/* Organisation Portal */}
              <div className="flex items-start gap-3 p-4 rounded-xl bg-white/10 border border-white/15 backdrop-blur-sm text-left">
                <div className="mt-0.5 p-2 rounded-lg bg-emerald-500/20 shrink-0">
                  <Building2 className="w-5 h-5 text-emerald-300" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">Organisation Portal</p>
                  <p className="text-white/65 text-sm leading-relaxed mt-0.5">
                    Register ecological projects, submit site boundaries, track monitoring cycles and access verified reports.
                  </p>
                </div>
              </div>

              {/* Operations Portal */}
              <div className="flex items-start gap-3 p-4 rounded-xl bg-white/10 border border-white/15 backdrop-blur-sm text-left">
                <div className="mt-0.5 p-2 rounded-lg bg-cyan-500/20 shrink-0">
                  <ShieldCheck className="w-5 h-5 text-cyan-300" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">Operations Portal</p>
                  <p className="text-white/65 text-sm leading-relaxed mt-0.5">
                    Verify submissions, run satellite MRV analysis, review evidence packages and manage report releases.
                  </p>
                </div>
              </div>
            </div>

              <Button variant="outline" size="lg" className="bg-white/10 border-white/20 text-white hover:bg-white/20" onClick={() => window.open('/', '_self')}>
                <Waves className="w-5 h-5 mr-2" />
                Learn How It Works
              </Button>
          </div>

          {/* ── Right panel — auth card ───────────────────────────────────── */}
          <Card className="w-full backdrop-blur-sm bg-card/95 shadow-2xl border-border/60">
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl font-heading">Sign in to NEVARA</CardTitle>
              <CardDescription>Access your portal using your registered credentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'login' | 'signup')} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6">
                  <TabsTrigger value="login" data-testid="tab-login">Sign In</TabsTrigger>
                  <TabsTrigger value="signup" data-testid="tab-signup">Register</TabsTrigger>
                </TabsList>

                {/* ── Login tab ── */}
                <TabsContent value="login" className="space-y-4">
                  <form onSubmit={loginForm.handleSubmit((d) => loginMutation.mutate(d))} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="login-email">Email</Label>
                      <Input
                        id="login-email"
                        type="email"
                        autoComplete="username"
                        placeholder="your.email@example.com"
                        data-testid="input-email"
                        {...loginForm.register('email')}
                      />
                      {loginForm.formState.errors.email && (
                        <p className="text-sm text-destructive">{loginForm.formState.errors.email.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="login-password">Password</Label>
                      <Input
                        id="login-password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="••••••••"
                        data-testid="input-password"
                        {...loginForm.register('password')}
                      />
                      {loginForm.formState.errors.password && (
                        <p className="text-sm text-destructive">{loginForm.formState.errors.password.message}</p>
                      )}
                    </div>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={loginMutation.isPending}
                      data-testid="button-login"
                    >
                      {loginMutation.isPending ? 'Signing in…' : (
                        <><LogIn className="w-4 h-4 mr-2" />Sign In</>
                      )}
                    </Button>
                  </form>
                </TabsContent>

                {/* ── Signup tab ── */}
                <TabsContent value="signup" className="space-y-4">
                  <div className="p-3 bg-primary/8 border border-primary/20 rounded-md">
                    <p className="text-sm text-primary font-medium">
                      Organisation accounts only. Contact the NEVARA team for Operations access.
                    </p>
                  </div>
                  <form onSubmit={signupForm.handleSubmit((d) => signupMutation.mutate(d))} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="signup-name">Full Name</Label>
                      <Input
                        id="signup-name"
                        autoComplete="name"
                        placeholder="Jane Smith"
                        data-testid="input-signup-name"
                        {...signupForm.register('name')}
                      />
                      {signupForm.formState.errors.name && (
                        <p className="text-sm text-destructive">{signupForm.formState.errors.name.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-email">Email Address</Label>
                      <Input
                        id="signup-email"
                        type="email"
                        autoComplete="username"
                        placeholder="yourname@organisation.com"
                        data-testid="input-signup-email"
                        {...signupForm.register('email')}
                      />
                      {signupForm.formState.errors.email && (
                        <p className="text-sm text-destructive">{signupForm.formState.errors.email.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-password">Password</Label>
                      <Input
                        id="signup-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="••••••••"
                        data-testid="input-signup-password"
                        {...signupForm.register('password')}
                      />
                      <p className="text-xs text-muted-foreground">
                        Min 8 characters · uppercase · lowercase · number · special character
                      </p>
                      {signupForm.formState.errors.password && (
                        <p className="text-sm text-destructive">{signupForm.formState.errors.password.message}</p>
                      )}
                    </div>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={signupMutation.isPending}
                      data-testid="button-signup"
                    >
                      {signupMutation.isPending ? 'Creating account…' : (
                        <><UserPlus className="w-4 h-4 mr-2" />Create Account</>
                      )}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>

              {/* ── Development accounts — hidden in production ── */}
              {import.meta.env.DEV && (
                <div className="mt-6 pt-5 border-t border-border/60">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-0"
                    onClick={() => setDevOpen((o) => !o)}
                  >
                    <span className="font-medium uppercase tracking-wide">Development Accounts</span>
                    {devOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  {devOpen && (
                    <div className="mt-3 space-y-2">
                      {DEV_ACCOUNTS.map((acc) => (
                        <button
                          key={acc.email}
                          type="button"
                          className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border/60 hover:bg-muted/60 transition-colors text-left"
                          onClick={() => fillDev(acc.email, acc.password)}
                          data-testid={`button-demo-${acc.portal.toLowerCase()}-${acc.email.split('@')[0]}`}
                        >
                          <span className="text-xs font-medium text-muted-foreground">{acc.portal}</span>
                          <code className="text-xs text-foreground/70 bg-muted px-2 py-0.5 rounded font-mono truncate">
                            {acc.label}
                          </code>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}
