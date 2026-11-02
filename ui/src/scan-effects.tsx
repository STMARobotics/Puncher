import { useEffect, useRef } from "react";

export function ScanEffects({ pulse }: { pulse: number }) {
  const trail = useRef<SVGGElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const chase = useRef<Animation | undefined>(undefined);
  const flash = useRef<Animation | undefined>(undefined);
  const burstFrame = useRef(0);

  useEffect(() => {
    chase.current = trail.current?.animate(
      [{ strokeDashoffset: "0" }, { strokeDashoffset: "100" }],
      { duration: 16000, iterations: Infinity, easing: "linear" },
    );
    return () => {
      cancelAnimationFrame(burstFrame.current);
      flash.current?.cancel();
      chase.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!pulse || !chase.current || !glow.current) return;
    cancelAnimationFrame(burstFrame.current);
    const animation = chase.current;
    const started = performance.now();
    const initialRate = animation.playbackRate;
    const peakRate = 8.5;
    const accelerateMs = 180;
    const coastMs = 5200;
    const step = (now: number) => {
      const elapsed = now - started;
      const accelerating = Math.min(1, elapsed / accelerateMs);
      const coasting = Math.min(
        1,
        Math.max(0, elapsed - accelerateMs) / coastMs,
      );
      const rate =
        elapsed < accelerateMs
          ? initialRate +
            (peakRate - initialRate) * (1 - (1 - accelerating) ** 3)
          : 1 + (peakRate - 1) * (1 - coasting) ** 2;
      // Changing playback rate preserves the current position around the border.
      animation.updatePlaybackRate(rate);
      if (coasting < 1) burstFrame.current = requestAnimationFrame(step);
    };
    burstFrame.current = requestAnimationFrame(step);

    const opacity = getComputedStyle(glow.current).opacity;
    flash.current?.cancel();
    flash.current = glow.current.animate(
      [
        { opacity, offset: 0 },
        { opacity: 1, offset: 0.055 },
        { opacity: 0.42, offset: 0.28 },
        { opacity: 0, offset: 1 },
      ],
      { duration: 2200, easing: "ease-out" },
    );
    return () => cancelAnimationFrame(burstFrame.current);
  }, [pulse]);

  return (
    <div className="scan-effects" aria-hidden="true">
      <div className="scan-glow" ref={glow} />
      <svg className="scan-chase" focusable="false">
        <g ref={trail}>
          <rect className="chase-bloom" x="1" y="1" rx="15" pathLength="100" />
          <rect className="chase-tail" x="1" y="1" rx="15" pathLength="100" />
          <rect className="chase-mid" x="1" y="1" rx="15" pathLength="100" />
          <rect className="chase-head" x="1" y="1" rx="15" pathLength="100" />
        </g>
      </svg>
    </div>
  );
}
