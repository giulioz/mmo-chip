import type { ReactNode, SVGProps } from "react";

type IconOpts = { fill?: string; stroke?: string; sw?: number };

function Icon(path: ReactNode, opts: IconOpts = {}): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="ico"
      fill={opts.fill || "none"}
      stroke={opts.stroke || "currentColor"}
      strokeWidth={opts.sw || 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}

export const Ic = {
  cursor: Icon(
    <>
      <rect x="2" y="2" width="12" height="12" strokeDasharray="2 1.6" opacity=".5" />
      <path d="M5 4l6 3.5-2.5.8L7.4 12 5 4z" fill="currentColor" stroke="none" />
    </>
  ),
  marquee: Icon(<rect x="2.5" y="3.5" width="11" height="9" />, { sw: 1.2 }),
  wire: Icon(
    <>
      <path d="M2 12l4-4h3l3-3 2 0" />
      <circle cx="2" cy="12" r="0.85" fill="currentColor" />
      <circle cx="6" cy="8" r="0.85" fill="currentColor" />
      <circle cx="9" cy="8" r="0.85" fill="currentColor" />
      <circle cx="12" cy="5" r="0.85" fill="currentColor" />
    </>
  ),
  bus: Icon(
    <>
      <path d="M2 11l3-3h3l3-3" />
      <path d="M2 13l3-3h3l3-3" opacity=".5" />
      <path d="M2 9l3-3h3l3-3" opacity=".5" />
    </>
  ),
  cell: Icon(
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M2.5 6h11M2.5 10h11M6 2.5v11M10 2.5v11" />
    </>
  ),
  pad: Icon(
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  addCell: Icon(
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M8 5.2v5.6M5.2 8h5.6" />
    </>
  ),
  // ── Die-viewer toolbar (representative tool glyphs) ──
  pan: Icon(
    <>
      <path d="M5.5 7.5V4.4a1 1 0 0 1 2 0v2.6" />
      <path d="M7.5 7V3.3a1 1 0 0 1 2 0V7" />
      <path d="M9.5 7.2V4.3a1 1 0 0 1 2 0V10a4 4 0 0 1-4 4H7a3 3 0 0 1-2.4-1.3L3 10.2c-.5-.9.7-1.8 1.5-1.1L5.5 10" />
    </>
  ),
  multiWire: Icon(
    <>
      <path d="M2.5 11l3.5-3.5h3l3.5-3.5" />
      <path d="M2.5 8.5l3.5-3.5h3l3.5-3.5" opacity=".5" />
    </>
  ),
  viaPoint: Icon(
    <>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  viaRect: Icon(
    <>
      <rect x="3" y="3" width="10" height="10" />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  viaPolygon: Icon(
    <>
      <path d="M8 2.6l5 3.2-1.7 5.8H4.7L3 5.8z" />
      <circle cx="8" cy="7.4" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  cellRect: Icon(
    <>
      <rect x="4" y="4" width="8" height="8" />
      <rect x="2.6" y="2.6" width="2.4" height="2.4" fill="currentColor" stroke="none" />
      <rect x="11" y="2.6" width="2.4" height="2.4" fill="currentColor" stroke="none" />
      <rect x="11" y="11" width="2.4" height="2.4" fill="currentColor" stroke="none" />
      <rect x="2.6" y="11" width="2.4" height="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  // Infinite guide: a full-bleed dashed line with outward arrow tips.
  gridLine: Icon(
    <>
      <path d="M8 1.5v13" strokeDasharray="2.2 2" />
      <path d="M6 3 8 1 10 3M6 13l2 2 2-2" />
    </>
  ),
  // Finite guide: a bounded segment with two endpoint handles.
  gridSeg: Icon(
    <>
      <path d="M4.5 8h7" />
      <circle cx="4" cy="8" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  ioPoint: Icon(
    <>
      <circle cx="6" cy="8" r="3" />
      <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
      <path d="M9 8h5" />
    </>
  ),
  // A cell stamped from the library, with a scale arrow on its corner.
  libraryCell: Icon(
    <>
      <rect x="2.5" y="2.5" width="8" height="8" />
      <path d="M2.5 6.5h8M6.5 2.5v8" opacity=".5" />
      <path d="M10.5 10.5l3 3M13.5 11v2.5H11" />
    </>
  ),
  rotateCw: Icon(
    <>
      <path d="M13 8a5 5 0 11-1.5-3.5" />
      <path d="M13 2v3h-3" />
    </>
  ),
  rotateCcw: Icon(
    <>
      <path d="M3 8a5 5 0 101.5-3.5" />
      <path d="M3 2v3h3" />
    </>
  ),
  flipH: Icon(
    <>
      <path d="M8 2v12" strokeDasharray="2 1.6" />
      <path d="M6 5L2.5 8 6 11zM10 5l3.5 3-3.5 3z" />
    </>
  ),
  flipV: Icon(
    <>
      <path d="M2 8h12" strokeDasharray="2 1.6" />
      <path d="M5 6L8 2.5 11 6zM5 10l3 3.5 3-3.5z" />
    </>
  ),
  check: Icon(<path d="M3 8.5l3 3 7-7" />),
  mlIgnore: Icon(
    <>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <path d="M4 12 12 4" />
    </>
  ),
  mlExclude: Icon(
    <>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  grid: Icon(<path d="M2.5 6h11M2.5 10h11M6 2.5v11M10 2.5v11" />),
  via: Icon(
    <>
      <rect x="4" y="4" width="8" height="8" />
      <rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  roi: Icon(<rect x="2.5" y="3.5" width="11" height="9" strokeDasharray="2 1.5" />),
  image: Icon(
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M3.5 12l3-3 2.5 2.5L11 9l2 2.5" />
    </>
  ),
  eye: Icon(
    <>
      <path d="M1.5 8s2-4.5 6.5-4.5S14.5 8 14.5 8 12.5 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  eyeOff: Icon(
    <>
      <path d="M1.5 8s2-4.5 6.5-4.5S14.5 8 14.5 8 12.5 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  lock: Icon(
    <>
      <rect x="3.5" y="7" width="9" height="6.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  search: Icon(
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  plus: Icon(<path d="M8 2.5v11M2.5 8h11" />),
  caret: Icon(<path d="M4 6l4 4 4-4" fill="currentColor" stroke="none" />),
  caretR: Icon(<path d="M6 4l4 4-4 4" fill="currentColor" stroke="none" />),
  caretD: Icon(<path d="M4 6l4 4 4-4" fill="currentColor" stroke="none" />),
  undo: Icon(
    <>
      <path d="M3 7h6.5a3.5 3.5 0 010 7H7" />
      <path d="M5 4L2 7l3 3" />
    </>
  ),
  redo: Icon(
    <>
      <path d="M13 7H6.5a3.5 3.5 0 000 7H9" />
      <path d="M11 4l3 3-3 3" />
    </>
  ),
  magnet: Icon(
    <>
      <path d="M4 3v5a4 4 0 008 0V3" />
      <path d="M4 3h2.4v3.4H4zM9.6 3H12v3.4H9.6z" fill="currentColor" />
    </>
  ),
  zoomIn: Icon(
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5M5 7h4M7 5v4" />
    </>
  ),
  zoomOut: Icon(
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5M5 7h4" />
    </>
  ),
  fit: Icon(<path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11" />),
  trash: Icon(
    <>
      <path d="M3 5h10M5.5 5V3.5h5V5M5 5l.5 9h5L11 5" />
    </>
  ),
  play: Icon(<path d="M4 3l9 5-9 5z" fill="currentColor" stroke="none" />),
  pause: Icon(
    <>
      <rect x="4" y="3" width="3" height="10" fill="currentColor" stroke="none" />
      <rect x="9" y="3" width="3" height="10" fill="currentColor" stroke="none" />
    </>
  ),
  refresh: Icon(
    <>
      <path d="M13 8a5 5 0 11-1.5-3.5" />
      <path d="M13 2v3h-3" />
    </>
  ),
  chev: Icon(<path d="M4 6l4 4 4-4" fill="currentColor" stroke="none" />),
  more: Icon(
    <>
      <circle cx="8" cy="3.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  sliders: Icon(
    <>
      <path d="M2 4h12M2 8h12M2 12h12" />
      <circle cx="5" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  user: Icon(
    <>
      <circle cx="8" cy="6" r="2.5" />
      <path d="M3.5 13.5c.7-2.5 2.5-3.5 4.5-3.5s3.8 1 4.5 3.5" />
    </>
  ),
  copy: Icon(
    <>
      <rect x="5" y="2.5" width="8" height="9" rx="1" />
      <path d="M3 4.5v8a1 1 0 001 1h6" />
    </>
  ),
  download: Icon(
    <>
      <path d="M8 2.5v8" />
      <path d="M4.5 7L8 10.5 11.5 7" />
      <path d="M2.5 13.5h11" />
    </>
  ),
  warn: Icon(
    <>
      <path d="M8 2.5L14.5 13.5h-13z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  err: Icon(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  link: Icon(
    <>
      <path d="M6.5 9.5l3-3" />
      <path d="M9.5 4.5a2.5 2.5 0 013.5 3.5l-2 2" />
      <path d="M6.5 11.5a2.5 2.5 0 01-3.5-3.5l2-2" />
    </>
  ),
};

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" {...props}>
      <rect x="1" y="1" width="18" height="18" rx="3.5" fill="#f5d68a" />
      <rect x="4" y="4" width="12" height="12" fill="none" stroke="#1c1610" strokeWidth="1.2" />
      <path
        d="M4 7h-2M4 10h-2M4 13h-2M16 7h2M16 10h2M16 13h2M7 4v-2M10 4v-2M13 4v-2M7 16v2M10 16v2M13 16v2"
        stroke="#1c1610"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <rect x="8" y="8" width="4" height="4" fill="#1c1610" />
    </svg>
  );
}
