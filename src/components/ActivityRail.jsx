import React from 'react';

/**
 * ActivityRail — VS Code-style icon rail for switching control panels.
 *
 * Desktop: narrow vertical rail on the far left; clicking the active group
 * again collapses the panel. Mobile (≤768px, via CSS): becomes a fixed
 * bottom tab bar and the controls panel becomes a bottom sheet.
 *
 * Props:
 *   groups   — [{id, title, icon}] where icon is a key of RAIL_ICONS
 *   active   — id of the open group (panel may still be collapsed)
 *   open     — whether the panel is visible
 *   onSelect — (id) => void; parent toggles collapse when id === active
 *   onPalette — optional; renders a command-palette button in the footer
 */

const RAIL_ICONS = {
  database: (
    <g>
      <ellipse cx="8" cy="4" rx="5.5" ry="2.5" />
      <path d="M2.5 4v8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V4" />
      <path d="M2.5 8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5" />
    </g>
  ),
  sliders: (
    <g>
      <path d="M2 4.5h8M12.5 4.5H14" /><circle cx="10.75" cy="4.5" r="1.75" />
      <path d="M2 11.5h2M6.5 11.5H14" /><circle cx="4.75" cy="11.5" r="1.75" />
    </g>
  ),
  target: (
    <g>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
    </g>
  ),
  layers: (
    <g>
      <path d="M8 2L14 5.5 8 9 2 5.5 8 2z" />
      <path d="M2 8.5L8 12l6-3.5" />
      <path d="M2 11.5L8 15l6-3.5" />
    </g>
  ),
  share: (
    <g>
      <path d="M8 10V2.5" />
      <path d="M5 5l3-3 3 3" />
      <path d="M3 8.5v4A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-4" />
    </g>
  ),
  command: (
    <g>
      <path d="M6 6h4v4H6z" />
      <path d="M6 6H4.5A1.5 1.5 0 1 1 6 4.5V6zM10 6h1.5A1.5 1.5 0 1 0 10 4.5V6zM6 10H4.5A1.5 1.5 0 1 0 6 11.5V10zM10 10h1.5a1.5 1.5 0 1 1-1.5 1.5V10z" />
    </g>
  ),
};

export function ActivityRail({ groups, active, open, onSelect, onPalette }) {
  return (
    <nav className="activity-rail" aria-label="Panels">
      <div className="activity-rail-groups" role="tablist">
        {groups.map((g) => {
          const isActive = active === g.id && open;
          return (
            <button
              key={g.id}
              role="tab"
              aria-selected={isActive}
              className={`rail-btn${isActive ? ' active' : ''}`}
              title={g.title}
              onClick={() => onSelect(g.id)}
            >
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none"
                stroke="currentColor" strokeWidth="1.3"
                strokeLinecap="round" strokeLinejoin="round">
                {RAIL_ICONS[g.icon] || RAIL_ICONS.database}
              </svg>
              <span className="rail-label">{g.title}</span>
            </button>
          );
        })}
      </div>
      {onPalette && (
        <div className="activity-rail-footer">
          <button
            className="rail-btn"
            title="All commands (Ctrl+Shift+{)"
            onClick={onPalette}
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="1.3"
              strokeLinecap="round" strokeLinejoin="round">
              {RAIL_ICONS.command}
            </svg>
            <span className="rail-label">Commands</span>
          </button>
        </div>
      )}
    </nav>
  );
}

export default ActivityRail;
