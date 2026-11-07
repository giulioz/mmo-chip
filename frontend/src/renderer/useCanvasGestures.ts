import { useCallback, useEffect, useRef, type RefObject } from "react";
import type {
  DragEventData,
  DragHandler,
  Interaction,
  PointerEventData,
  PointerModifiers
} from "./interaction";
import type { Viewport } from "./types";

const WHEEL_ZOOM_FACTOR = 0.01;
const CLICK_MOVE_THRESHOLD_PX = 4;

type GestureMode = "pan" | "ignore" | { kind: "custom"; handler: DragHandler };

interface GestureState {
  pointerId: number;
  button: number;
  startScreenX: number;
  startScreenY: number;
  startWorldX: number;
  startWorldY: number;
  lastScreenX: number;
  lastScreenY: number;
  moved: boolean;
  mode: GestureMode;
}

export interface CanvasGestureOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Live viewport (mutated by setViewport). */
  viewportRef: RefObject<Viewport>;
  /** Clamped viewport setter owned by the canvas. */
  setViewport: (v: Viewport) => void;
  /** Latest parent `onPointerDown` (decides the interaction per gesture). */
  onPointerDownRef: RefObject<((e: PointerEventData) => Interaction) | undefined>;
  /** Latest parent `onCanvasClick` (fired on a no-drag left click in pan mode). */
  onCanvasClickRef: RefObject<((p: { x: number; y: number }) => void) | undefined>;
  minZoom: number;
  maxZoom: number;
}

/**
 * Owns the pointer/wheel gesture machinery for the tiled canvas: pointer
 * capture, world conversion, the click-vs-drag threshold, built-in pan/zoom,
 * and dispatch to a parent-supplied `DragHandler`. Returns the React pointer
 * handlers to spread onto the `<canvas>`; the non-passive wheel listener is
 * managed internally.
 */
export function useCanvasGestures({
  canvasRef,
  viewportRef,
  setViewport,
  onPointerDownRef,
  onCanvasClickRef,
  minZoom,
  maxZoom
}: CanvasGestureOptions) {
  const gestureRef = useRef<GestureState | null>(null);

  const screenToWorld = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const vp = viewportRef.current;
      return { x: vp.originX + sx / vp.zoom, y: vp.originY + sy / vp.zoom };
    },
    [viewportRef]
  );

  const screenPointFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },
    [canvasRef]
  );

  const modifiersFrom = (
    event: React.PointerEvent<HTMLCanvasElement>
  ): PointerModifiers => ({
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    ctrl: event.ctrlKey
  });

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Only handle primary (left) and middle buttons.
      if (event.button !== 0 && event.button !== 1) return;
      event.currentTarget.setPointerCapture(event.pointerId);

      const screen = screenPointFromEvent(event);
      const world = screenToWorld(screen.x, screen.y);

      // Middle button always pans; left button defers to the parent.
      let mode: GestureMode = "pan";
      if (event.button === 0 && onPointerDownRef.current) {
        const result = onPointerDownRef.current({
          worldPoint: world,
          screenPoint: screen,
          button: event.button,
          modifiers: modifiersFrom(event)
        });
        if (result === "pan") mode = "pan";
        else if (result === "ignore") mode = "ignore";
        else mode = { kind: "custom", handler: result };
      }

      gestureRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        startScreenX: event.clientX,
        startScreenY: event.clientY,
        startWorldX: world.x,
        startWorldY: world.y,
        lastScreenX: event.clientX,
        lastScreenY: event.clientY,
        moved: false,
        mode
      };
    },
    [screenPointFromEvent, screenToWorld, onPointerDownRef]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;

      const wasMoved = g.moved;
      if (!g.moved) {
        const totalDx = event.clientX - g.startScreenX;
        const totalDy = event.clientY - g.startScreenY;
        if (Math.hypot(totalDx, totalDy) > CLICK_MOVE_THRESHOLD_PX) g.moved = true;
      }

      if (g.mode === "ignore") {
        g.lastScreenX = event.clientX;
        g.lastScreenY = event.clientY;
        return;
      }

      if (g.mode === "pan") {
        if (g.moved) {
          const dx = event.clientX - g.lastScreenX;
          const dy = event.clientY - g.lastScreenY;
          const vp = viewportRef.current;
          setViewport({
            originX: vp.originX - dx / vp.zoom,
            originY: vp.originY - dy / vp.zoom,
            zoom: vp.zoom
          });
        }
      } else {
        const screen = screenPointFromEvent(event);
        const world = screenToWorld(screen.x, screen.y);
        const e: DragEventData = {
          worldPoint: world,
          startWorld: { x: g.startWorldX, y: g.startWorldY },
          screenPoint: screen,
          modifiers: modifiersFrom(event)
        };
        if (!wasMoved && g.moved) g.mode.handler.onDragStart?.(e);
        if (g.moved) g.mode.handler.onDragMove?.(e);
      }

      g.lastScreenX = event.clientX;
      g.lastScreenY = event.clientY;
    },
    [setViewport, screenPointFromEvent, screenToWorld, viewportRef]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      gestureRef.current = null;

      if (g.mode === "ignore") return;

      const screen = screenPointFromEvent(event);
      const world = screenToWorld(screen.x, screen.y);

      if (g.mode === "pan") {
        if (!g.moved && g.button === 0 && onCanvasClickRef.current) {
          onCanvasClickRef.current(world);
        }
      } else {
        g.mode.handler.onPointerUp({
          worldPoint: world,
          startWorld: { x: g.startWorldX, y: g.startWorldY },
          screenPoint: screen,
          modifiers: modifiersFrom(event),
          dragged: g.moved
        });
      }
    },
    [screenPointFromEvent, screenToWorld, onCanvasClickRef]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (g.mode !== "pan" && g.mode !== "ignore") g.mode.handler.onCancel?.();
    },
    []
  );

  // Native wheel handler bound non-passively so we can preventDefault.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const vp = viewportRef.current;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
        const newZoom = vp.zoom * factor;
        const worldX = vp.originX + cssX / vp.zoom;
        const worldY = vp.originY + cssY / vp.zoom;
        const clamped = Math.max(minZoom, Math.min(maxZoom, newZoom));
        setViewport({
          originX: worldX - cssX / clamped,
          originY: worldY - cssY / clamped,
          zoom: clamped
        });
      } else if (e.shiftKey) {
        setViewport({
          originX: vp.originX + e.deltaY / vp.zoom,
          originY: vp.originY + e.deltaX / vp.zoom,
          zoom: vp.zoom
        });
      } else {
        setViewport({
          originX: vp.originX + e.deltaX / vp.zoom,
          originY: vp.originY + e.deltaY / vp.zoom,
          zoom: vp.zoom
        });
      }
    };
    const preventGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", handler, { passive: false });
    el.addEventListener("gesturestart", preventGesture, { passive: false });
    el.addEventListener("gesturechange", preventGesture, { passive: false });
    el.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      el.removeEventListener("wheel", handler);
      el.removeEventListener("gesturestart", preventGesture);
      el.removeEventListener("gesturechange", preventGesture);
      el.removeEventListener("gestureend", preventGesture);
    };
  }, [canvasRef, viewportRef, minZoom, maxZoom, setViewport]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
