import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center mx-auto mb-6 border border-border/60">
          <Compass className="w-7 h-7 text-muted-foreground/60" />
        </div>

        {/* Code */}
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
          Error 404
        </p>

        {/* Heading */}
        <h1 className="text-2xl font-heading font-bold tracking-tight mb-3">
          Page not found
        </h1>

        {/* Body */}
        <p className="text-muted-foreground text-sm leading-relaxed mb-8">
          The resource you requested does not exist or has been moved.
          Return to the platform to continue your work.
        </p>

        {/* CTA */}
        <Link href="/">
          <Button variant="outline" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Return to NEVARA
          </Button>
        </Link>
      </div>
    </div>
  );
}
