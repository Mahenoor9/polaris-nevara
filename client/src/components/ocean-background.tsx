export function OceanBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-ocean-gradient opacity-90" />
      
      <div className="absolute inset-0">
        {[...Array(15)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-white/10 animate-float"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              width: `${Math.random() * 60 + 20}px`,
              height: `${Math.random() * 60 + 20}px`,
              animationDelay: `${Math.random() * 6}s`,
              animationDuration: `${Math.random() * 4 + 6}s`,
            }}
          />
        ))}
      </div>

      <svg
        className="absolute bottom-0 left-0 w-[200%] h-32 animate-wave"
        viewBox="0 0 1200 120"
        preserveAspectRatio="none"
      >
        <path
          d="M0,64 C300,100 600,20 900,64 C1200,108 1500,28 1800,64 L1800,120 L0,120 Z"
          fill="hsl(var(--ocean-gradient-end))"
          fillOpacity="0.3"
        />
      </svg>
    </div>
  );
}

export function SubtleOceanBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-background" />
      
      <div className="absolute inset-0 opacity-30">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-primary/20 animate-float-slow"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              width: `${Math.random() * 40 + 15}px`,
              height: `${Math.random() * 40 + 15}px`,
              animationDelay: `${Math.random() * 8}s`,
              animationDuration: `${Math.random() * 6 + 8}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
