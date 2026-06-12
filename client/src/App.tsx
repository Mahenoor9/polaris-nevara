import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { ThemeProvider } from "./lib/theme-provider";
import { Navbar } from "./components/navbar";
import { ComplianceDisclaimer } from "./components/compliance-disclaimer";
import { NotificationProvider } from "./components/notification-center";
import { OfflineBanner } from "./components/offline-banner";
import NewLanding from "./pages/new-landing/Landing";
import HowItWorks from "./pages/new-landing/HowItWorks";
import WhyNevara from "./pages/new-landing/WhyNevara";
import Roadmap from "./pages/new-landing/Roadmap";
import About from "./pages/new-landing/About";
import Login from "./pages/login";
import UserDashboard from "./pages/user-dashboard";
import OperationsDashboard from "./pages/operations-dashboard";
import NotFound from "./pages/not-found";
import TermsOfService from "./pages/terms";
import PrivacyPolicy from "./pages/privacy";
import MRVReport from "./pages/mrv-report";
import ProjectIntelligenceOverview from "./pages/project-intelligence";
import PublicProjectPage from "./pages/public-project";

function ProtectedRoute({
  component: Component,
  allowedRoles,
}: {
  component: React.ComponentType;
  allowedRoles?: string[];
}) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 bg-background">
        <div className="flex items-center gap-2.5 mb-2">
          <img src="/nivara-ring-logo.png" alt="NEVARA" className="w-8 h-8 object-contain opacity-80" />
          <span className="font-heading text-xl font-bold tracking-tight text-foreground/70">NEVARA</span>
        </div>
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground">Initialising platform…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    const roleRedirects: Record<string, string> = {
      admin: '/operations',
      verifier: '/operations',
      contributor: '/dashboard',
    };
    return <Redirect to={roleRedirects[user.role] || '/dashboard'} />;
  }

  return <Component />;
}

function Router() {
  const { isAuthenticated } = useAuth();

  return (
    <>
      <Switch>
        <Route path="/" component={NewLanding} />
        <Route path="/how-it-works" component={HowItWorks} />
        <Route path="/why-nevara" component={WhyNevara} />
        <Route path="/roadmap" component={Roadmap} />
        <Route path="/about" component={About} />

        {/* Public transparency pages — no auth, no navbar */}
        <Route path="/projects/:id/transparency" component={PublicProjectPage} />

        {/* Platform Routes with Navbar */}
        <Route path="/*">
          {() => (
            <>
              <Navbar />
              <Switch>
                <Route path="/login" component={Login} />
                <Route path="/dashboard">
                  {() => <ProtectedRoute component={UserDashboard} allowedRoles={['contributor']} />}
                </Route>
                {/* Unified internal operations dashboard */}
                <Route path="/operations">
                  {() => <ProtectedRoute component={OperationsDashboard} allowedRoles={['verifier', 'admin']} />}
                </Route>
                <Route path="/operations/project/:id">
                  {() => <ProtectedRoute component={ProjectIntelligenceOverview} allowedRoles={['verifier', 'admin']} />}
                </Route>
                {/* Legacy route redirects */}
                <Route path="/admin">
                  {() => <Redirect to="/operations" />}
                </Route>
                <Route path="/verifier">
                  {() => <Redirect to="/operations" />}
                </Route>
                <Route path="/verifier/project/:id">
                  {(params: any) => <Redirect to={`/operations/project/${params?.id ?? ''}`} />}
                </Route>
                <Route path="/terms" component={TermsOfService} />
                <Route path="/privacy" component={PrivacyPolicy} />
                <Route path="/projects/:id/mrv-report" component={MRVReport} />
                <Route component={NotFound} />
              </Switch>
            </>
          )}
        </Route>
      </Switch>
      {/* Task 9.3: Persistent compliance disclaimer on every page */}
      <ComplianceDisclaimer variant="banner" />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <NotificationProvider>
            <TooltipProvider>
              <Toaster />
              <OfflineBanner />
              <Router />
            </TooltipProvider>
          </NotificationProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
