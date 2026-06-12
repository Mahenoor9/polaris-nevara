import React from "react"
import { PixelTrail } from "./pixel-trail"
import { useScreenSize } from "@/components/hooks/use-screen-size"
import { cn } from "@/lib/utils"

interface PixelTrailBackgroundProps {
    className?: string
}

export const PixelTrailBackground: React.FC<PixelTrailBackgroundProps> = ({ className }) => {
    const screenSize = useScreenSize()

    return (
        <div className={cn("bg-ocean-gradient pointer-events-none", className)}>
            <PixelTrail
                pixelSize={screenSize.lessThan("md") ? 24 : 40}
                fadeDuration={1200}
                delay={0}
                pixelClassName="rounded-full bg-cyan-200/40 shadow-[0_0_12px_rgba(255,255,255,0.4)]"
            />
        </div>
    )
}
