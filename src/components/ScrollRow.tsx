/**
 * ScrollRow — a horizontally scrolling media row engineered for both touch/mouse and 10-foot Smart TV spatial navigation.
 * 
 * Features:
 * - Hover/active-revealed arrow buttons that page by ~85% of visible width.
 * - Dynamic edge fade masks.
 * - Wheel-to-horizontal scrolling.
 * - Norigin Spatial Navigation integration for Smart TV remotes and keyboard D-Pad.
 * - FocusableItem with 3-meter TV visual pop (scale-105, heavy glowing border, drop shadow).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';

interface Props {
  children: React.ReactNode;
  className?: string;
  /** Disable snapping for rows of mixed-width items. */
  snap?: boolean;
  focusKey?: string;
}

export function ScrollRow({ children, className = '', snap = true, focusKey }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const { ref: spatialRef } = useFocusable({
    focusKey,
  });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  const page = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth && e.deltaY > 0;
    if (atStart || atEnd) return;
    e.preventDefault();
    el.scrollBy({ left: e.deltaY, behavior: 'auto' });
  };

  return (
    <div className="relative group/row" ref={spatialRef}>
      {/* Edge fades */}
      <div
        aria-hidden
        className={`pointer-events-none absolute left-0 top-0 bottom-2 w-12 z-10 transition-opacity duration-200 ${
          canLeft ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ background: 'linear-gradient(to right, rgba(6,6,26,0.95), transparent)' }}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute right-0 top-0 bottom-2 w-12 z-10 transition-opacity duration-200 ${
          canRight ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ background: 'linear-gradient(to left, rgba(6,6,26,0.95), transparent)' }}
      />

      {canLeft && (
        <button
          aria-label="Scroll left"
          onClick={() => page(-1)}
          className="absolute left-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full
                     bg-black/70 border border-white/15 text-white/80 backdrop-blur-md
                     flex items-center justify-center opacity-0 group-hover/row:opacity-100
                     focus:opacity-100 hover:bg-black/90 hover:scale-110 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      {canRight && (
        <button
          aria-label="Scroll right"
          onClick={() => page(1)}
          className="absolute right-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full
                     bg-black/70 border border-white/15 text-white/80 backdrop-blur-md
                     flex items-center justify-center opacity-0 group-hover/row:opacity-100
                     focus:opacity-100 hover:bg-black/90 hover:scale-110 transition-all"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      <div
        ref={ref}
        onWheel={onWheel}
        className={`flex gap-3 overflow-x-auto pb-2 ${snap ? 'snap-x snap-mandatory' : ''} ${className}`}
        style={{ scrollbarWidth: 'none', scrollPaddingLeft: '0.25rem' }}
      >
        {children}
      </div>
    </div>
  );
}

export interface FocusableItemProps {
  children: React.ReactNode;
  className?: string;
  onSelect?: () => void;
  focusKey?: string;
}

/**
 * FocusableItem — wraps poster cards for Smart TV / 10-foot UI spatial navigation.
 * Highlights with high-contrast glowing cyan border and scale effect visible from 3 meters away.
 */
export function FocusableItem({ children, className = '', onSelect, focusKey }: FocusableItemProps) {
  const { ref, focused } = useFocusable({
    focusKey,
    onEnterPress: onSelect,
  });

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [focused]);

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={`transition-all duration-200 transform outline-none ${
        focused
          ? 'scale-105 ring-4 ring-cyan-400 border-cyan-300 shadow-2xl shadow-cyan-500/50 z-30 focused'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
