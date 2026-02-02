import React, { useState } from 'react';

/**
 * StatusWindow - Collapsible debug/status window at bottom of screen
 */
export function StatusWindow({ logs = [], isCollapsed: externalCollapsed, onToggle }) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  // Use external collapsed state if provided, otherwise use internal
  const isCollapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const handleToggle = onToggle || (() => setInternalCollapsed(!internalCollapsed));

  const containerStyle = {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1e1e1e',
    borderTop: '2px solid #444',
    zIndex: 1000,
    transition: 'all 0.3s ease',
    maxHeight: isCollapsed ? '32px' : '300px',
    overflow: 'hidden',
    fontFamily: 'monospace',
    fontSize: '12px',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: '#252525',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: isCollapsed ? 'none' : '1px solid #444',
  };

  const titleStyle = {
    color: '#ddd',
    fontWeight: 'bold',
    fontSize: '13px',
  };

  const toggleButtonStyle = {
    color: '#888',
    fontSize: '14px',
    fontWeight: 'bold',
  };

  const contentStyle = {
    padding: '8px 12px',
    maxHeight: '268px',
    overflowY: 'auto',
    color: '#ddd',
  };

  const logEntryStyle = (type) => ({
    padding: '4px 8px',
    marginBottom: '4px',
    borderLeft: `3px solid ${getLogColor(type)}`,
    backgroundColor: '#2a2a2a',
    borderRadius: '2px',
  });

  const timestampStyle = {
    color: '#666',
    marginRight: '8px',
  };

  const messageStyle = (type) => ({
    color: getLogColor(type),
  });

  function getLogColor(type) {
    switch (type) {
      case 'error':
        return '#f44336';
      case 'warning':
        return '#ff9800';
      case 'success':
        return '#4caf50';
      case 'info':
        return '#2196f3';
      default:
        return '#999';
    }
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle} onClick={handleToggle}>
        <div style={titleStyle}>
          Status Window
          {logs.length > 0 && !isCollapsed && (
            <span style={{ marginLeft: '8px', color: '#666' }}>
              ({logs.length} {logs.length === 1 ? 'entry' : 'entries'})
            </span>
          )}
        </div>
        <div style={toggleButtonStyle}>
          {isCollapsed ? '▲' : '▼'}
        </div>
      </div>

      {!isCollapsed && (
        <div style={contentStyle}>
          {logs.length === 0 ? (
            <div style={{ color: '#666', fontStyle: 'italic' }}>
              No status messages yet...
            </div>
          ) : (
            logs.map((log, index) => (
              <div key={index} style={logEntryStyle(log.type)}>
                <span style={timestampStyle}>{log.timestamp}</span>
                <span style={messageStyle(log.type)}>{log.message}</span>
                {log.details && (
                  <div style={{ marginTop: '4px', color: '#888', fontSize: '11px', paddingLeft: '80px' }}>
                    {log.details}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default StatusWindow;
