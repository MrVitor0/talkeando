// A few UI glyphs Discord uses that aren't in the copied icon set
// (channel hash, search, edit/delete row actions, owner crown). Kept as
// inline single-path SVGs so they inherit `color` like the masked icons.

function Svg({ d, size, className, box = 24 }: { d: string; size: number; className?: string; box?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      fill="currentColor"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <path fillRule="evenodd" clipRule="evenodd" d={d} />
    </svg>
  );
}

const HASH =
  "M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z";
const SEARCH =
  "M15.62 17.03a9 9 0 1 1 1.41-1.41l3.68 3.67a1 1 0 0 1-1.42 1.42l-3.67-3.68ZM17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0Z";
const PENCIL =
  "M19.29 4.71a2.41 2.41 0 0 0-3.4 0l-1.06 1.06 3.4 3.4 1.06-1.06a2.41 2.41 0 0 0 0-3.4ZM13.4 7.36l-9.11 9.12a1 1 0 0 0-.26.45l-1 3.6a.5.5 0 0 0 .62.62l3.6-1a1 1 0 0 0 .45-.26l9.12-9.11-3.4-3.4Z";
const TRASH =
  "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a.5.5 0 0 0-.5.53l.72 12.36A2.5 2.5 0 0 0 7.78 22h8.44a2.5 2.5 0 0 0 2.5-2.11l.72-12.36a.5.5 0 0 0-.5-.53H5.06Z";
const CROWN =
  "M2.68 6.44a1 1 0 0 1 1.5-.9L8 7.8l3.16-4.74a1 1 0 0 1 1.68 0L16 7.8l3.82-2.26a1 1 0 0 1 1.5.9l-1 10.06a1 1 0 0 1-1 .9H4.68a1 1 0 0 1-1-.9l-1-10.06ZM4.5 19.5c0-.28.22-.5.5-.5h14c.28 0 .5.22.5.5v.75c0 .41-.34.75-.75.75H5.25a.75.75 0 0 1-.75-.75v-.75Z";
const FULLSCREEN =
  "M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm16 0v6h-6v-2h4v-4h2Z";
const CONTRACT =
  "M9 4h2v6H5V8h4V4Zm4 0h2v4h4v2h-6V4ZM5 14h6v6H9v-4H5v-2Zm8 0h6v2h-4v4h-2v-6Z";
const PIP =
  "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v-2h6V7H5v8h4v2H5a2 2 0 0 1-2-2V5Zm7 8h9v6h-9v-6Z";
const DOTS =
  "M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z";
const THEATER =
  "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 3v8h14V8H5Z";
const MUSIC_NOTE =
  "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6Z";
const LIGHTNING =
  "M7 2v11h3v9l7-12h-4l4-8H7Z";

export const HashIcon = (p: { size?: number; className?: string }) => <Svg d={HASH} size={p.size ?? 24} className={p.className} />;
export const SearchIcon = (p: { size?: number; className?: string }) => <Svg d={SEARCH} size={p.size ?? 16} className={p.className} />;
export const PencilIcon = (p: { size?: number; className?: string }) => <Svg d={PENCIL} size={p.size ?? 16} className={p.className} />;
export const TrashIcon = (p: { size?: number; className?: string }) => <Svg d={TRASH} size={p.size ?? 16} className={p.className} />;
export const CrownIcon = (p: { size?: number; className?: string }) => <Svg d={CROWN} size={p.size ?? 14} className={p.className} box={24} />;
export const FullscreenIcon = (p: { size?: number; className?: string }) => <Svg d={FULLSCREEN} size={p.size ?? 18} className={p.className} />;
export const ContractIcon = (p: { size?: number; className?: string }) => <Svg d={CONTRACT} size={p.size ?? 18} className={p.className} />;
export const PipIcon = (p: { size?: number; className?: string }) => <Svg d={PIP} size={p.size ?? 18} className={p.className} />;
export const DotsIcon = (p: { size?: number; className?: string }) => <Svg d={DOTS} size={p.size ?? 18} className={p.className} />;
export const TheaterIcon = (p: { size?: number; className?: string }) => <Svg d={THEATER} size={p.size ?? 18} className={p.className} />;
export const MusicNoteIcon = (p: { size?: number; className?: string }) => <Svg d={MUSIC_NOTE} size={p.size ?? 14} className={p.className} />;
export const LightningIcon = (p: { size?: number; className?: string }) => <Svg d={LIGHTNING} size={p.size ?? 14} className={p.className} />;

