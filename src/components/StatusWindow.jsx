import React, { useState, useRef, useEffect } from 'react';

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
      <div
        className="status-pulltab"
        onClick={handleToggle}
        style={{
          position: 'fixed',
          bottom: '24px', // sit right above the footer
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1001,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '3px 14px',
          backgroundColor: 'var(--sardine-bg-panel, #122240)',
          border: '1px solid var(--sardine-border, #1e3a5f)',
          borderBottom: 'none',
          borderRadius: '6px 6px 0 0',
          cursor: 'pointer',
          userSelect: 'none',
          fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
          fontSize: '0.6rem',
          color: 'var(--text-muted, #5a7099)',
          letterSpacing: '0.5px',
          transition: 'color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.color = 'var(--sardine-cyan, #4ec9d4)';
          e.currentTarget.style.borderColor = 'var(--sardine-cyan-dim, #2a8a93)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.color = 'var(--text-muted, #5a7099)';
          e.currentTarget.style.borderColor = 'var(--sardine-border, #1e3a5f)';
        }}
      >
        <span style={{ fontSize: '8px' }}>▲</span>
        <span>STATUS</span>
        {logs.length > 0 && (
          <span style={{
            minWidth: '16px',
            height: '16px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '8px',
            backgroundColor: 'var(--sardine-cyan-bg, rgba(78, 201, 212, 0.08))',
            color: 'var(--sardine-cyan, #4ec9d4)',
            fontSize: '0.55rem',
            fontWeight: '600',
            padding: '0 4px',
          }}>
            {logs.length}
          </span>
        )}
      </div>
    );
  }

  // Expanded state
  const containerStyle = {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'var(--sardine-bg-raised, #0f1f38)',
    borderTop: '1px solid var(--sardine-border, #1e3a5f)',
    zIndex: 1001,
    transition: 'max-height 0.3s ease',
    maxHeight: '300px',
    overflow: 'hidden',
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    fontSize: '12px',
  };

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
    fontSize: '0.75rem',
    letterSpacing: '1px',
    textTransform: 'uppercase',
  };

  const toggleButtonStyle = {
    color: 'var(--text-muted, #5a7099)',
    fontSize: '14px',
    fontWeight: 'bold',
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

  const tabStyle = (active) => ({
    padding: '3px 10px',
    borderRadius: '4px',
    fontSize: '0.7rem',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    cursor: 'pointer',
    userSelect: 'none',
    background: active ? 'var(--sardine-cyan-bg, rgba(78,201,212,0.1))' : 'transparent',
    border: active ? '1px solid var(--sardine-cyan-dim, #2a8a93)' : '1px solid transparent',
    color: active ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--text-muted, #5a7099)',
  });

  return (
    <div className="status-window" style={containerStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {allTabs.map(t => (
            <div
              key={t.id}
              style={tabStyle(currentTab === t.id)}
              onClick={(e) => { e.stopPropagation(); selectTab(t.id); }}
            >
              {t.label}
              {t.id === 'status' && logs.length > 0 && (
                <span style={{ marginLeft: '6px', color: 'var(--text-disabled, #3a5070)' }}>{logs.length}</span>
              )}
            </div>
          ))}
        </div>
        <div style={toggleButtonStyle} onClick={handleToggle}>▼</div>
      </div>

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
                  <div style={{ marginTop: '4px', color: 'var(--text-muted, #5a7099)', fontSize: '11px', paddingLeft: '80px' }}>
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
    </div>
  );
}

export default StatusWindow;
