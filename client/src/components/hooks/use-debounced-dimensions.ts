import { useState, useEffect, RefObject } from 'react';

interface Dimensions {
    width: number;
    height: number;
}

export function useDimensions(ref: RefObject<HTMLElement | SVGElement>): Dimensions {
    const [dimensions, setDimensions] = useState<Dimensions>({ width: 0, height: 0 });

    useEffect(() => {
        if (!ref.current) return;

        const updateDimensions = () => {
            if (ref.current) {
                const { width, height } = ref.current.getBoundingClientRect();
                setDimensions({ width, height });
            }
        };

        // Initial measurement
        updateDimensions();

        const resizeObserver = new ResizeObserver(() => {
            // Use requestAnimationFrame to avoid "ResizeObserver loop limit exceeded" errors
            window.requestAnimationFrame(() => {
                updateDimensions();
            });
        });

        resizeObserver.observe(ref.current);

        return () => {
            resizeObserver.disconnect();
        };
    }, [ref]);

    return dimensions;
}
