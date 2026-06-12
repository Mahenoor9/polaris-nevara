import React, { useCallback, useMemo, useRef, useEffect } from "react"
import { motion, useAnimationControls } from "framer-motion"
import { v4 as uuidv4 } from "uuid"

import { cn } from "@/lib/utils"
// Ensure this import path is accurate or matches the project's alias setup
import { useDimensions } from "@/components/hooks/use-debounced-dimensions"

interface PixelTrailProps {
    pixelSize: number // px
    fadeDuration?: number // ms
    delay?: number // ms
    className?: string
    pixelClassName?: string
}

const PixelTrail: React.FC<PixelTrailProps> = ({
    pixelSize = 20,
    fadeDuration = 500,
    delay = 0,
    className,
    pixelClassName,
}) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const dimensions = useDimensions(containerRef)
    const trailId = useRef(uuidv4())

    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (!containerRef.current) return;

            const rect = containerRef.current.getBoundingClientRect();
            // Only trigger if mouse is within the container bounds
            if (
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom
            ) {
                const x = Math.floor((e.clientX - rect.left) / pixelSize);
                const y = Math.floor((e.clientY - rect.top) / pixelSize);

                const pixelElement = document.getElementById(
                    `${trailId.current}-pixel-${x}-${y}`
                );
                if (pixelElement) {
                    const animatePixel = (pixelElement as any).__animatePixel;
                    if (animatePixel) animatePixel();
                }
            }
        };

        window.addEventListener("mousemove", handleGlobalMouseMove);
        return () => window.removeEventListener("mousemove", handleGlobalMouseMove);
    }, [pixelSize]);

    const columns = useMemo(
        () => Math.ceil(dimensions.width / pixelSize),
        [dimensions.width, pixelSize]
    )
    const rows = useMemo(
        () => Math.ceil(dimensions.height / pixelSize),
        [dimensions.height, pixelSize]
    )

    return (
        <div
            ref={containerRef}
            className={cn(
                "absolute inset-0 w-full h-full pointer-events-none",
                className
            )}
            style={{
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, ${pixelSize}px)`,
                gridTemplateRows: `repeat(${rows}, ${pixelSize}px)`,
            }}
        >
            {Array.from({ length: rows * columns }).map((_, index) => {
                const colIndex = index % columns;
                const rowIndex = Math.floor(index / columns);
                return (
                    <PixelDot
                        key={`${colIndex}-${rowIndex}`}
                        id={`${trailId.current}-pixel-${colIndex}-${rowIndex}`}
                        size={pixelSize}
                        fadeDuration={fadeDuration}
                        delay={delay}
                        className={pixelClassName}
                    />
                );
            })}
        </div>
    );
}

interface PixelDotProps {
    id: string
    size: number
    fadeDuration: number
    delay: number
    className?: string
}

const PixelDot: React.FC<PixelDotProps> = React.memo(
    ({ id, size, fadeDuration, delay, className }) => {
        const controls = useAnimationControls()

        const animatePixel = useCallback(() => {
            controls.start({
                opacity: [1, 0],
                scale: [1, 1.5],
                transition: { duration: fadeDuration / 1000, delay: delay / 1000, ease: "easeOut" },
            })
        }, [controls, fadeDuration, delay])

        // Attach the animatePixel function to the DOM element
        const ref = useCallback(
            (node: HTMLDivElement | null) => {
                if (node) {
                    ; (node as any).__animatePixel = animatePixel
                }
            },
            [animatePixel]
        )

        return (
            <motion.div
                id={id}
                ref={ref}
                className={cn("cursor-pointer-none pointer-events-none", className)}
                style={{
                    width: `${size}px`,
                    height: `${size}px`,
                }}
                initial={{ opacity: 0 }}
                animate={controls}
                exit={{ opacity: 0 }}
            />
        )
    }
)

PixelDot.displayName = "PixelDot"
export { PixelTrail }
