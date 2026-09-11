import React, { useState, useRef, useEffect } from 'react';
import { Button, Toolbar } from './ui/index.js';

/**
 * StatusWindow - Collapsible debug/status window at bottom of screen.
 * When collapsed, shows a small pull-tab above the footer for easy re-opening.
 */
export function StatusWindow({ logs = [], isCollapsed: externalCollapsed, onToggle, tabs = [], activeTab, onTabChange }) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [internalTab, setInternalTab] = useState(null);
  const contentRef = useRef(null);

  // Use external collapsed state if provided, otherwise use internal
  const isCollapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const handleToggle = onToggle || (() => setInternalCollapsed(!internalCollapsed));

  // Extra tabs beyond the built-in Status log. 'status' is the reserved id.
  const allTabs = [{ id: 'status', label: 'Status' }, ...tabs];
  const currentTab = (activeTab !== undefined ? activeTab : internalTab) || 'status';
  const selectTab = (id) => { onTabChange ? onTabChange(id) : setInternalTab(id); };
  const activeContent = tabs.find(t => t.id === currentTab)?.content ?? null;

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (!isCollapsed && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [logs.length, isCollapsed]);

  // When collapsed, render a small pull-tab above the footer
  if (isCollapsed) {
    return (
      <button
        type="button"
        className="status-pulltab"
        onClick={handleToggle}
        aria-expanded={false}
        aria-label={`Show status log${logs.length ? ` (${logs.length} entries)` : ''}`}
      >
        <span aria-hidden="true">▲</span>
        <span>STATUS</span>
        {logs.length > 0 && <span className="status-pulltab__count">{logs.length}</span>}
      </button>
    );
  }

  // Expanded state

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: 'var(--sardine-bg-panel, #122240)',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid var(--sardine-border-subtle, #162d4a)',
  };

  const titleStyle = {
    color: 'var(--text-primary, #e8edf5)',
    fontWeight: '600',
    fontSize: 'var(--text-sm)',
    letterSpacing: '1px',
    textTransform: 'uppercase',
  };

  const contentStyle = {
    padding: '8px 12px',
    maxHeight: '268px',
    overflowY: 'auto',
    color: 'var(--text-secondary, #8fa4c4)',
  };

  const logEntryStyle = (type) => ({
    padding: '4px 8px',
    marginBottom: '4px',
    borderLeft: `3px solid ${getLogColor(type)}`,
    backgroundColor: 'var(--sardine-bg, #0a1628)',
    borderRadius: '2px',
  });

  const timestampStyle = {
    color: 'var(--text-disabled, #3a5070)',
    marginRight: '8px',
  };

  const messageStyle = (type) => ({
    color: getLogColor(type),
  });

  function getLogColor(type) {
    switch (type) {
      case 'error':
        return 'var(--status-flood, #ff5c5c)';
      case 'warning':
        return 'var(--sardine-orange, #e8833a)';
      case 'success':
        return 'var(--status-success, #3ddc84)';
      case 'info':
        return 'var(--sardine-cyan, #4ec9d4)';
      default:
        return 'var(--text-muted, #5a7099)';
    }
  }

  return (
    <section className="status-window" aria-label="Status log">
      <header style={headerStyle}>
        <h2 className="status-window__heading">Status log</h2>
        <Toolbar role="tablist" aria-label="Status panels" wrap={false}>
          {allTabs.map(t => (
            <Button
              key={t.id}
              role="tab"
              aria-selected={currentTab === t.id}
              active={currentTab === t.id}
              className="status-window__tab"
              onClick={(e) => { e.stopPropagation(); selectTab(t.id); }}
            >
              {t.label}
              {t.id === 'status' && logs.length > 0 && (
                <span className="status-window__count">{logs.length}</span>
              )}
            </Button>
          ))}
        </Toolbar>
        <Button icon variant="ghost" label="Collapse status log" onClick={handleToggle}>▼</Button>
      </header>

      {currentTab === 'status' ? (
        <div style={contentStyle} ref={contentRef}>
          {logs.length === 0 ? (
            <div style={{ color: 'var(--text-disabled, #3a5070)', fontStyle: 'italic' }}>
              No status messages yet...
            </div>
          ) : (
            logs.map((log, index) => (
              <div key={index} style={logEntryStyle(log.type)}>
                <span style={timestampStyle}>{log.timestamp}</span>
                <span style={messageStyle(log.type)}>{log.message}</span>
                {log.details && (
                  <div style={{ marginTop: '4px', color: 'var(--text-muted, #5a7099)', fontSize: 'var(--text-xs)', paddingLeft: '80px' }}>
                    {log.details}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <div style={{ ...contentStyle, color: 'var(--text-secondary, #8fa4c4)' }}>
          {activeContent}
        </div>
      )}
    </section>
  );
}

export default StatusWindow;
