/**
 * WorkflowPanel — Live YAML workflow display that updates as user interacts.
 *
 * Shows the current processing state as a structured YAML parameter file.
 * The user can:
 *   - Watch it populate in real-time as they adjust settings
 *   - Edit it directly
 *   - Save it as a .yaml file
 *   - Apply edits back to the app state
 *   - Use it from the CLI with `sardine-process`
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { generateWorkflowYAML, parseWorkflowYAML, downloadWorkflowYAML } from '../utils/workflow-yaml.js';

/**
 * @param {Object} props
 * @param {Object} props.workflowState   - Current app state for YAML generation
 * @param {Function} props.onApply       - Called with parsed state when user clicks Apply
 * @param {Function} [props.onStatus]    - Status log callback (type, message)
 * @param {boolean}  [props.visible]     - Whether panel is visible
 * @param {Function} [props.onToggle]    - Toggle visibility
 */
export function WorkflowPanel({ workflowState, onApply, onStatus, visible = true, onToggle }) {
  const [yaml, setYaml] = useState('');
  const [isEdited, setIsEdited] = useState(false);
  const textRef = useRef(null);
  const autoUpdateRef = useRef(true);

  // Auto-regenerate YAML when state changes (unless user is editing)
  useEffect(() => {
    if (!isEdited && autoUpdateRef.current && workflowState) {
      const newYaml = generateWorkflowYAML(workflowState);
      setYaml(newYaml);
    }
  }, [workflowState, isEdited]);

  const handleEdit = useCallback((e) => {
    setYaml(e.target.value);
    setIsEdited(true);
  }, []);

  const handleApply = useCallback(() => {
    try {
      const parsed = parseWorkflowYAML(yaml);
      onApply?.(parsed);
      setIsEdited(false);
      autoUpdateRef.current = true;
      onStatus?.('success', 'Workflow applied to current session');
    } catch (e) {
      onStatus?.('error', `Failed to parse workflow: ${e.message}`);
    }
  }, [yaml, onApply, onStatus]);

  const handleSave = useCallback(() => {
    const source = workflowState?.file || 'untitled';
    const name = source.split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
    downloadWorkflowYAML(yaml, `${name}-workflow.yaml`);
    onStatus?.('success', `Saved: ${name}-workflow.yaml`);
  }, [yaml, workflowState, onStatus]);

  const handleReset = useCallback(() => {
    setIsEdited(false);
    autoUpdateRef.current = true;
    if (workflowState) {
      setYaml(generateWorkflowYAML(workflowState));
    }
    onStatus?.('info', 'Workflow reset to current state');
  }, [workflowState, onStatus]);

  // Toggle button (always visible)
  const toggleBtn = (
    <button
      onClick={onToggle}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--sardine-bg-raised)',
        border: '1px solid var(--sardine-border)',
        borderRadius: 'var(--radius-md)',
        padding: '6px 10px',
        cursor: 'pointer',
        color: 'var(--sardine-cyan)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        transition: 'all var(--transition-fast)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ opacity: 0.7 }}>{visible ? '\u25BC' : '\u25B6'}</span>
        Workflow
        {isEdited && (
          <span style={{
            fontSize: '0.55rem',
            background: 'var(--sardine-orange-bg)',
            color: 'var(--sardine-orange)',
            padding: '1px 5px',
            borderRadius: '2px',
            textTransform: 'none',
          }}>edited</span>
        )}
      </span>
      <span style={{
        fontSize: '0.55rem',
        color: 'var(--text-muted)',
        textTransform: 'none',
        fontWeight: 400,
      }}>YAML</span>
    </button>
  );

  if (!visible) {
    return <div style={{ marginBottom: 'var(--space-md)' }}>{toggleBtn}</div>;
  }

  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      {toggleBtn}

      <div style={{
        marginTop: '4px',
        background: 'var(--sardine-bg)',
        border: '1px solid var(--sardine-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}>
        {/* YAML textarea */}
        <textarea
          ref={textRef}
          value={yaml}
          onChange={handleEdit}
          spellCheck={false}
          style={{
            width: '100%',
            minHeight: '220px',
            maxHeight: '400px',
            resize: 'vertical',
            background: 'var(--sardine-bg)',
            color: isEdited ? 'var(--sardine-orange)' : 'var(--text-secondary)',
            border: 'none',
            padding: '8px',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.65rem',
            lineHeight: 1.5,
            outline: 'none',
            boxSizing: 'border-box',
            whiteSpace: 'pre',
            overflowWrap: 'normal',
            overflowX: 'auto',
          }}
        />

        {/* Action buttons */}
        <div style={{
          display: 'flex',
          gap: '4px',
          padding: '6px 8px',
          borderTop: '1px solid var(--sardine-border-subtle)',
          background: 'var(--sardine-bg-raised)',
        }}>
          <button
            onClick={handleSave}
            style={{
              flex: 1,
              fontSize: '0.65rem',
              padding: '4px 8px',
              fontFamily: 'var(--font-mono)',
              background: 'var(--sardine-cyan-bg)',
              color: 'var(--sardine-cyan)',
              border: '1px solid var(--sardine-cyan-dim)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              letterSpacing: '0.3px',
            }}
          >
            Save .yaml
          </button>

          {isEdited && (
            <>
              <button
                onClick={handleApply}
                style={{
                  flex: 1,
                  fontSize: '0.65rem',
                  padding: '4px 8px',
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--sardine-orange-bg)',
                  color: 'var(--sardine-orange)',
                  border: '1px solid var(--sardine-orange-dim)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                Apply
              </button>
              <button
                onClick={handleReset}
                style={{
                  flex: 1,
                  fontSize: '0.65rem',
                  padding: '4px 8px',
                  fontFamily: 'var(--font-mono)',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--sardine-border)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
