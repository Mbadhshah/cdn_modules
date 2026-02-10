import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';

// --- MOCK DEPENDENCIES (Replacements for missing external files) ---

// Mock hook for connection context
const useConnection = () => {
    // defaults to 'connected' so you can test UI features immediately
    const [connectionStatus, setConnectionStatus] = useState('connected');
    
    const sendWebSocketMessage = (msg) => {
        console.log("Mock WS Send:", msg);
        // Dispatch a fake response for position requests to make the UI lively
        if (msg === '#POS') {
            const fakeX = (Math.random() * 2).toFixed(3);
            const fakeY = (Math.random() * 2).toFixed(3);
            const fakeZ = (Math.random() * 2).toFixed(3);
            // Simulate an async response
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('websocket-message', {
                    detail: { message: `POS:${fakeX},${fakeY},${fakeZ}|0.000,0.000,0.000` }
                }));
            }, 50);
        }
        // Dispatch ok for simulation
        if (msg.startsWith('G') || msg.startsWith('M')) {
             setTimeout(() => {
                window.dispatchEvent(new CustomEvent('websocket-message', {
                    detail: { message: 'ok' }
                }));
            }, 100);
        }
    };

    const espInfo = { baseUrl: 'http://mock-esp-device.local' };

    return { connectionStatus, sendWebSocketMessage, espInfo };
};

// Mock function for API upload
const uploadGcodeFile = async (baseUrl, file, type) => {
    console.log(`[Mock API] Uploading ${type} file to ${baseUrl}:`, file.name);
    return new Promise(resolve => setTimeout(resolve, 1000));
};

// --- CSS STYLES ---
const styles = `
:root {
  --bg-gradient: radial-gradient(circle at top left, #2c3e50, #000000);
  --glass-bg: rgba(255, 255, 255, 0.07);
  --glass-border: rgba(255, 255, 255, 0.1);
  --accent: #00d2ff;
  --success: #00ff9d;
  --text: #ffffff;
  --text-muted: rgba(255, 255, 255, 0.5);
  --block-motion: #4c97ff;
  --block-vacuum: #9966ff;
}

.roboblock-studio-body {
  margin: 0;
  height: 100vh;
  width: 100%;
  background: var(--bg-gradient);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* --- MAIN LAYOUT --- */
#main-container {
  display: flex;
  flex: 1;
  overflow: hidden;
  height: 100%;
  gap: clamp(15px, 1.5vw, 25px);
  padding: clamp(20px, 2vw, 30px);
  min-height: 0;
  box-sizing: border-box;
}

/* PALETTE (Left) */
#palette {
  width: 280px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 24px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.palette-header { color: var(--text-muted); font-size: 12px; text-transform: uppercase; margin-bottom: 15px; font-weight: bold; letter-spacing: 1px;}

/* RUN Button */
.run-btn {
  background: rgba(0, 255, 157, 0.2);
  border: 1px solid var(--success);
  border-radius: 8px;
  color: var(--success);
  padding: 8px 16px;
  font-size: 11px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.run-btn:hover {
  background: rgba(0, 255, 157, 0.3);
  box-shadow: 0 0 10px rgba(0, 255, 157, 0.3);
  transform: translateY(-1px);
}
.run-btn:active {
  transform: scale(0.95);
}
.run-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* WORKSPACE (Right) */
#workspace {
  flex: 1;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 24px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  position: relative;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.workspace-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 15px 20px;
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
  min-height: 50px;
  position: sticky;
  top: 0;
  background: var(--glass-bg);
  z-index: 10;
  margin-bottom: 0;
}

.workspace-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 1px;
  color: var(--text-muted);
  text-transform: uppercase;
  flex: 1;
}

.workspace-header-buttons {
  display: flex;
  gap: 10px;
  align-items: center;
}

.gcode-toggle-btn {
  background: rgba(0, 210, 255, 0.2);
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: var(--accent);
  padding: 8px 16px;
  font-size: 11px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gcode-toggle-btn:hover {
  background: rgba(0, 210, 255, 0.3);
  box-shadow: 0 0 10px rgba(0, 210, 255, 0.3);
}

.gcode-toggle-btn:active {
  transform: scale(0.95);
}

.workspace-content {
  flex: 1;
  overflow: hidden;
  padding: 20px;
  min-height: 0;
  display: flex;
  gap: 20px;
}

.workspace-blocks-list {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 15px;
  overflow-y: auto;
  max-height: 100%;
}

.workspace-blocks-list::-webkit-scrollbar {
  width: 6px;
}

.workspace-blocks-list::-webkit-scrollbar-track {
  background: transparent;
}

.workspace-blocks-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.workspace-blocks-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

.workspace-stats-panel {
  width: 320px;
  min-width: 320px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  max-height: 100%;
  position: sticky;
  top: 0;
  align-self: flex-start;
}

.stats-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--glass-border);
}

.stats-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-item-full {
  flex: 1;
  min-height: 0;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.stat-value {
  font-size: 24px;
  font-weight: bold;
  color: var(--accent);
  font-family: 'Courier New', monospace;
}

.simulate-btn {
  width: 100%;
  padding: 10px;
  background: rgb(48 209 88 / 39%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
  margin-top: 8px;
}

.simulate-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.simulate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.stat-breakdown {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.breakdown-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: all 0.2s;
}

.breakdown-item:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.breakdown-item.selected {
  background: rgba(0, 210, 255, 0.15);
  border-color: var(--accent);
  box-shadow: 0 0 10px rgba(0, 210, 255, 0.2);
}

.breakdown-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
}

.breakdown-count {
  font-size: 16px;
  font-weight: bold;
  color: var(--accent);
  font-family: 'Courier New', monospace;
}

.breakdown-extension {
  margin-top: 8px;
  margin-left: 12px;
  padding-left: 12px;
  border-left: 2px solid var(--accent);
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: slideDown 0.2s ease-out;
}

@keyframes slideDown {
  from {
      opacity: 0;
      transform: translateY(-10px);
  }
  to {
      opacity: 1;
      transform: translateY(0);
  }
}

.extension-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 12px;
}

.extension-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: var(--accent);
  color: #000;
  border-radius: 50%;
  font-size: 10px;
  font-weight: bold;
  font-family: 'Courier New', monospace;
  flex-shrink: 0;
}

.extension-details {
  color: var(--text);
  font-family: 'Courier New', monospace;
  flex: 1;
}

/* Block highlighting */
.workspace-block.highlighted {
  animation: glowPulse 1s ease-in-out infinite;
  box-shadow: 0 0 20px rgba(0, 210, 255, 0.6), 0 0 40px rgba(0, 210, 255, 0.4);
  border-color: var(--accent);
  transform: scale(1.02);
}

@keyframes glowPulse {
  0%, 100% {
      box-shadow: 0 0 20px rgba(0, 210, 255, 0.6), 0 0 40px rgba(0, 210, 255, 0.4);
  }
  50% {
      box-shadow: 0 0 30px rgba(0, 210, 255, 0.8), 0 0 60px rgba(0, 210, 255, 0.6);
  }
}

/* Extension Popup */
.extension-popup {
  position: fixed;
  width: 300px;
  max-width: 90vw;
  max-height: 400px;
  background: var(--glass-bg);
  backdrop-filter: blur(25px);
  -webkit-backdrop-filter: blur(25px);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  z-index: 1001;
  overflow: hidden;
}

.extension-popup-header {
  background: rgba(0,0,0,0.3);
  padding: 12px 16px;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: move;
  user-select: none;
}

.extension-popup-header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--accent);
}

.extension-popup-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.extension-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.extension-close-btn:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}

.extension-popup-content {
  padding: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.extension-popup-content .extension-item {
  transition: all 0.2s;
}

.extension-popup-content .extension-item:hover {
  background: rgba(0, 210, 255, 0.1);
  border-color: rgba(0, 210, 255, 0.3);
  transform: translateX(4px);
}

.extension-popup-content::-webkit-scrollbar {
  width: 6px;
}

.extension-popup-content::-webkit-scrollbar-track {
  background: transparent;
}

.extension-popup-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.extension-popup-content::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

/* Custom scrollbar for stats panel */
.workspace-stats-panel::-webkit-scrollbar {
  width: 6px;
}

.workspace-stats-panel::-webkit-scrollbar-track {
  background: transparent;
}

.workspace-stats-panel::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

.workspace-stats-panel::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

/* Custom scrollbar styling */
.workspace-content::-webkit-scrollbar,
#palette::-webkit-scrollbar {
  width: 6px;
}
.workspace-content::-webkit-scrollbar-track,
#palette::-webkit-scrollbar-track {
  background: transparent;
}
.workspace-content::-webkit-scrollbar-thumb,
#palette::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
.workspace-content::-webkit-scrollbar-thumb:hover,
#palette::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

#workspace-hint {
  color: rgba(255,255,255,0.2); 
  font-size: 20px; 
  pointer-events: none;
  text-align: center;
  padding: 40px 20px;
  width: 100%;
}

/* --- BLOCKS --- */
.block {
  padding: 12px 16px;
  margin-bottom: 15px;
  border-radius: 8px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: fit-content;
  min-width: 180px;
  position: relative;
  box-shadow: 0 4px 6px rgba(0,0,0,0.3);
  user-select: none;
  transition: transform 0.1s;
  border: 1px solid rgba(255,255,255,0.2);
  gap: 10px;
}
.block:active { cursor: grabbing; }

.block-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  font-size: 12px;
  font-weight: bold;
  color: var(--accent);
  flex-shrink: 0;
  font-family: 'Courier New', monospace;
}

/* Puzzle Nub */
.block::after {
  content: ''; position: absolute; bottom: -6px; left: 20px;
  width: 20px; height: 6px; background-color: inherit;
  border-radius: 0 0 6px 6px; clip-path: polygon(0 0, 100% 0, 85% 100%, 15% 100%);
}
.block::before {
  content: ''; position: absolute; top: 0; left: 20px;
  width: 20px; height: 6px; background: rgba(0,0,0,0.2); /* Notch shadow */
  border-radius: 0 0 6px 6px; clip-path: polygon(0 0, 100% 0, 85% 100%, 15% 100%);
}

.block-motion { background: var(--block-motion); }
.block-vacuum { background: var(--block-vacuum); }

/* Values display inside block */
.block-params {
  background: rgba(0,0,0,0.2);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
  margin-left: 10px;
  pointer-events: none; /* Let clicks pass to block */
}

/* Workspace Block specific */
.workspace-block {
  margin-bottom: -6px !important; /* Stack them */
  filter: drop-shadow(0 5px 10px rgba(0,0,0,0.5));
}
.workspace-block .delete-btn {
  margin-left: 10px; cursor: pointer; opacity: 0.6; font-size: 16px;
}
.workspace-block .delete-btn:hover { opacity: 1; color: #ff4757; }


/* --- MODAL OVERLAY --- */
#modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  animation: fadeIn 0.2s;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* Download Options Modal */
.download-options-modal {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 0;
  min-width: 400px;
  max-width: 500px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  position: relative;
  animation: slideDown 0.3s ease-out;
}

.download-options-header {
  padding: 20px 24px;
  margin: 0;
  border-bottom: 1px solid var(--glass-border);
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  text-align: center;
}

.download-options-content {
  padding: 24px;
}

.download-options-content p {
  margin: 0 0 20px 0;
  color: var(--text-muted);
  text-align: center;
  font-size: 14px;
}

.download-options-buttons {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.download-option-btn {
  width: 100%;
  padding: 14px 20px;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.download-option-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--accent);
  transform: translateY(-1px);
}

.save-pc-btn {
  background: rgba(48, 209, 88, 0.2);
  border-color: rgba(48, 209, 88, 0.4);
}

.save-pc-btn:hover {
  background: rgba(48, 209, 88, 0.3);
  border-color: rgba(48, 209, 88, 0.6);
}

.send-device-btn {
  background: rgba(100, 149, 237, 0.2);
  border-color: rgba(100, 149, 237, 0.4);
}

.send-device-btn:hover {
  background: rgba(100, 149, 237, 0.3);
  border-color: rgba(100, 149, 237, 0.6);
}

.download-options-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 24px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
}

.download-options-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

/* --- CONTROL PANEL (Inside Modal) --- */
.control-panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 24px;
  padding: 30px;
  width: 450px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  animation: popIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
@keyframes popIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }

.panel-header { font-size: 18px; font-weight: bold; margin-bottom: 20px; color: var(--accent); text-transform: uppercase; letter-spacing: 2px; border-bottom: 1px solid var(--glass-border); padding-bottom: 10px; width: 100%; text-align: center; }

/* Views */
.view-section { display: none; width: 100%; flex-direction: column; align-items: center; }
.view-section.active { display: flex; }

/* Common Control Styles */
.mode-toggle { display: flex; background: rgba(0,0,0,0.3); border-radius: 20px; padding: 4px; width: 80%; margin-bottom: 20px; }
.mode-btn { flex: 1; padding: 10px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: 16px; font-weight: bold; transition: 0.2s; }
.mode-btn.active { background: var(--accent); color: #000; }

.joystick-group { display: flex; gap: 30px; align-items: center; margin-bottom: 20px; }
.joystick-base { width: 180px; height: 180px; background: rgba(0,0,0,0.3); border-radius: 50%; position: relative; border: 2px solid var(--glass-border); }
.joystick-stick { width: 70px; height: 70px; background: linear-gradient(135deg, #555, #222); border-radius: 50%; position: absolute; top:55px; left:55px; box-shadow: 0 5px 15px rgba(0,0,0,0.5); cursor: grab; }

/* Z-axis Joystick */
.z-joystick-base {
  width: 50px;
  height: 180px;
  background: rgba(0,0,0,0.3);
  border-radius: 25px;
  position: relative;
  border: 2px solid var(--glass-border);
  display: flex;
  justify-content: center;
  align-items: center;
}

.z-joystick-stick {
  width: 38px;
  height: 30px;
  background: linear-gradient(135deg, #555, #222);
  border-radius: 10px;
  position: absolute;
  box-shadow: 0 5px 15px rgba(0,0,0,0.5);
  cursor:grab;
}

/* Buttons Dpad */
.dpad-grid { display: grid; grid-template-columns: repeat(3, 50px); gap: 5px; margin-bottom: 20px; }
.btn-dpad { width: 50px; height: 50px; background: rgba(255,255,255,0.1); border: 1px solid var(--glass-border); border-radius: 8px; color: white; cursor: pointer; font-size: 20px; display:flex; align-items:center; justify-content:center;}
.btn-dpad:active { background: var(--accent); color: black; }
.btn-dpad.u { grid-column: 2; } .btn-dpad.l { grid-column: 1; grid-row: 2; } .btn-dpad.r { grid-column: 3; grid-row: 2; } .btn-dpad.d { grid-column: 2; grid-row: 3; }

/* Horizontal Slider */
.h-slider-group { width: 90%; margin-bottom: 15px; }
.h-slider-lbl { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-bottom: 5px; }
input.h-slider { width: 100%; -webkit-appearance: none; appearance: none; background: rgba(255,255,255,0.1); height: 6px; border-radius: 3px; }
input.h-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; background: var(--text); border-radius: 50%; cursor: pointer; margin-top: -6px; }

/* Save Button */
.save-btn { width: 100%; padding: 15px; margin-top: 20px; background: var(--accent); color: black; font-weight: bold; border: none; border-radius: 12px; cursor: pointer; font-size: 16px; box-shadow: 0 5px 20px rgba(0,210,255,0.3); transition: transform 0.1s; }
.save-btn:active { transform: scale(0.98); }

.coord-display { font-family: monospace; color: var(--accent); background: rgba(0,0,0,0.4); padding: 10px; border-radius: 8px; margin-top: 10px; width: 100%; text-align: center; }

/* Step Selector Radio Buttons */
.step-selector {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 10px 15px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 12px;
  border: 1px solid var(--glass-border);
  margin-top: 10px;
}

.step-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-right: 5px;
}

.radio-label {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 8px;
  transition: all 0.2s;
  position: relative;
}

.radio-label:hover {
  background: rgba(255, 255, 255, 0.05);
}

.radio-label input[type="radio"] {
  appearance: none;
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border: 2px solid var(--glass-border);
  border-radius: 50%;
  margin-right: 6px;
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  background: rgba(0, 0, 0, 0.3);
}

.radio-label input[type="radio"]:checked {
  border-color: var(--accent);
  background: var(--accent);
}

.radio-label input[type="radio"]:checked::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #000;
}

.radio-label span {
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  user-select: none;
}

.radio-label input[type="radio"]:checked + span {
  color: var(--accent);
  font-weight: 600;
}

/* G-Code Popup */
.gcode-popup {
  position: fixed;
  width: 400px;
  max-width: 90vw;
  max-height: 600px;
  background: var(--glass-bg);
  backdrop-filter: blur(25px);
  -webkit-backdrop-filter: blur(25px);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  overflow: hidden;
}

.gcode-popup-header {
  background: rgba(0,0,0,0.3);
  padding: 15px 20px;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: move;
  user-select: none;
}

.gcode-popup-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text);
}

.gcode-popup-controls {
  display: flex;
  align-items: center;
  gap: 15px;
}

.gcode-count {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.gcode-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.gcode-close-btn:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}

.gcode-popup-content {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.gcode-popup-content::-webkit-scrollbar {
  width: 8px;
}

.gcode-popup-content::-webkit-scrollbar-track {
  background: transparent;
}

.gcode-popup-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.gcode-popup-content::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

.gcode-popup-content {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
}

.gcode-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-muted);
  font-style: italic;
  opacity: 0.5;
}

.gcode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gcode-line {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  background: rgba(0,0,0,0.2);
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.05);
  font-family: 'Courier New', monospace;
  font-size: 13px;
  transition: all 0.2s;
}

.gcode-line:hover {
  background: rgba(0,0,0,0.3);
  border-color: rgba(0, 210, 255, 0.3);
}

.gcode-line-num {
  color: var(--text-muted);
  font-weight: bold;
  min-width: 35px;
}

.gcode-command {
  color: var(--text);
  flex: 1;
}
`;

const PALETTE_BLOCKS = [
    { type: 'motion', label: 'Move to Point', icon: '✥' },
    { type: 'vacuum', label: 'Pick & Place ', icon: '◎' },
];

function PickAndPlacePage() {
    const [simulationCount, setSimulationCount] = useState(1);
    // Use the internal mock hook instead of the external file
    const { connectionStatus, sendWebSocketMessage, espInfo } = useConnection();
    const [workspaceBlocks, setWorkspaceBlocks] = useState([]);
    const [modalOpen, setModalOpen] = useState(false);
    const [activeBlock, setActiveBlock] = useState(null);
    const [tempState, setTempState] = useState({});
    const [motionMode, setMotionMode] = useState('joy');
    const [showGcodePopup, setShowGcodePopup] = useState(false);
    const [popupPosition, setPopupPosition] = useState({ x: 50, y: 50 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [selectedBlockType, setSelectedBlockType] = useState(null);
    const [highlightedBlockId, setHighlightedBlockId] = useState(null);
    const [extensionPopupPosition, setExtensionPopupPosition] = useState({ x: 0, y: 0 });
    const [isDraggingExtension, setIsDraggingExtension] = useState(false);
    const [extensionDragOffset, setExtensionDragOffset] = useState({ x: 0, y: 0 });
    const [showDownloadOptions, setShowDownloadOptions] = useState(false);
    const [positionFetched, setPositionFetched] = useState(false);
    const [isSimulating, setIsSimulating] = useState(false);

    const extensionPopupRef = useRef(null);
    const extensionHeaderRef = useRef(null);
    const posPollIntervalRef = useRef(null);
    const gcodeQueueRef = useRef([]);
    const currentGcodeIndexRef = useRef(0);
    const waitingForOkRef = useRef(false);
    const isSimulatingRef = useRef(false);

    const joyStickRef = useRef(null);
    const joyBaseRef = useRef(null);
    const isJoyDraggingRef = useRef(false);
    const joyIntervalRef = useRef(null);
    const joyStickPosRef = useRef({ dx: 0, dy: 0 });
    const popupRef = useRef(null);
    const popupHeaderRef = useRef(null);

    // Parse POS response from ESP: "POS:0.000,0.000,0.000|0.000,0.000,0.000"
    const parsePosResponse = (message) => {
        if (!message || typeof message !== 'string') return null;

        const trimmed = message.trim();
        const posMatch = trimmed.match(/POS:\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*|\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)/);
        if (posMatch) {
            return {
                machine: {
                    x: parseFloat(posMatch[1]) || 0,
                    y: parseFloat(posMatch[2]) || 0,
                    z: parseFloat(posMatch[3]) || 0
                },
                work: {
                    x: parseFloat(posMatch[4]) || 0,
                    y: parseFloat(posMatch[5]) || 0,
                    z: parseFloat(posMatch[6]) || 0
                }
            };
        }
        return null;
    };

    // Send G-code command
    const sendGcode = (cmd) => {
        if (!cmd || !cmd.trim()) return;
        if (connectionStatus !== 'connected' || !sendWebSocketMessage) return;

        const trimmedCmd = cmd.trim();
        sendWebSocketMessage(trimmedCmd);
    };

    const getBlockLabel = (block) => {
        const { type, vals } = block;
        if (type === 'motion') return `X:${vals.x} Y:${vals.y} Z:${vals.z}`;
        if (type === 'vacuum') return vals.on ? `ON` : `OFF`;
        return "";
    };

    const handleDragStart = (e, block) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(block));
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleDrop = (e) => {
        e.preventDefault();
        const droppedBlock = JSON.parse(e.dataTransfer.getData('text/plain'));

        const newBlock = {
            id: uuidv4(),
            type: droppedBlock.type,
            vals: droppedBlock.type === 'motion' ? { x: 0, y: 0, z: 0 } : { on: false }
        };

        setWorkspaceBlocks(prev => [...prev, newBlock]);

        // If it's a motion block, reset position fetched flag
        if (droppedBlock.type === 'motion') {
            setPositionFetched(false);
        }

        openModal(newBlock);
    };

    const handleDeleteBlock = (e, blockId) => {
        e.stopPropagation();
        setWorkspaceBlocks(blocks => blocks.filter(b => b.id !== blockId));
    };

    const openModal = (block) => {
        setActiveBlock(block);
        setTempState({ ...block.vals });
        setModalOpen(true);

        // Start continuous position polling if it's a motion block and online
        if (block.type === 'motion' && connectionStatus === 'connected') {
            startPositionPolling();
        }
    };

    // Start continuous position polling
    const startPositionPolling = () => {
        if (connectionStatus !== 'connected' || !sendWebSocketMessage) return;

        // Clear any existing interval
        if (posPollIntervalRef.current) {
            clearInterval(posPollIntervalRef.current);
        }

        // Send initial request immediately
        sendWebSocketMessage('#POS');

        // Then poll continuously every 200ms
        posPollIntervalRef.current = setInterval(() => {
            if (connectionStatus === 'connected' && sendWebSocketMessage) {
                sendWebSocketMessage('#POS');
            }
        }, 200);
    };

    // Stop position polling
    const stopPositionPolling = () => {
        if (posPollIntervalRef.current) {
            clearInterval(posPollIntervalRef.current);
            posPollIntervalRef.current = null;
        }
    };

    const saveBlockSettings = () => {
        if (!activeBlock) return;

        // Stop position polling
        stopPositionPolling();

        setWorkspaceBlocks(blocks => blocks.map(b =>
            b.id === activeBlock.id ? { ...b, vals: tempState } : b
        ));

        setModalOpen(false);
        setActiveBlock(null);
        setPositionFetched(false); // Reset flag for next motion block
    };

    const generateGcode = () => {
        if (workspaceBlocks.length === 0) return "type: pickandplace\n";

        let gcode = "type: pickandplace\n";

        workspaceBlocks.forEach((blk) => {
            const { type, vals: d } = blk;
            if (type === 'motion') gcode += `G0 X${d.x.toFixed(1)} Y${d.y.toFixed(1)} Z${d.z.toFixed(1)}\n`;
            if (type === 'vacuum') gcode += d.on ? `M05\n` : `M03\n`;
        });

        return gcode;
    };

    // Send next G-code line from queue
    const sendNextGcodeLine = useCallback(() => {
        if (currentGcodeIndexRef.current >= gcodeQueueRef.current.length) {
            // All lines sent
            isSimulatingRef.current = false;
            setIsSimulating(false);
            gcodeQueueRef.current = [];
            currentGcodeIndexRef.current = 0;
            waitingForOkRef.current = false;
            setHighlightedBlockId(null);
            alert("Simulation completed!");
            return;
        }

        if (waitingForOkRef.current) {
            // Still waiting for ok, don't send next line yet
            return;
        }

        const line = gcodeQueueRef.current[currentGcodeIndexRef.current];
        if (line) {
            waitingForOkRef.current = true;
            sendGcode(line);

            // Map G-code line to block for highlighting
            // Structure: [Block1, Block2, ...] repeated for each loop
            // Each loop has workspaceBlocks.length lines
            const linesPerLoop = workspaceBlocks.length;
            const blockIndex = currentGcodeIndexRef.current % linesPerLoop;
            
            if (blockIndex >= 0 && blockIndex < workspaceBlocks.length) {
                setHighlightedBlockId(workspaceBlocks[blockIndex].id);
            }
        }
    }, [workspaceBlocks]);

    // Handle ok response and send next line
    const handleOkResponse = useCallback(() => {
        if (!isSimulatingRef.current || !waitingForOkRef.current) return;

        // Received ok, move to next line
        waitingForOkRef.current = false;
        currentGcodeIndexRef.current += 1;

        // Small delay before sending next line
        setTimeout(() => {
            sendNextGcodeLine();
        }, 50);
    }, [sendNextGcodeLine]);

    // Simulate function - sends G-code line by line waiting for ok
    const handleSimulate = () => {
        if (workspaceBlocks.length === 0) {
            alert("Workspace empty! Please add blocks before simulating.");
            return;
        }

        if (connectionStatus !== 'connected') {
            alert("Not connected to ESP. Please connect first.");
            return;
        }

        if (isSimulating) {
            alert("Simulation already in progress!");
            return;
        }

        // Generate G-code and split into lines
        const fullGcode = generateGcode();
        const lines = fullGcode.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('type:')); // Filter out empty lines and type prefix

        if (lines.length === 0) {
            alert("No G-code to simulate!");
            return;
        }

        let allLines = [];
        for (let i = 0; i < simulationCount; i++) {
            allLines = [...allLines, ...lines];
        }
        // Initialize queue
        gcodeQueueRef.current = allLines;
        currentGcodeIndexRef.current = 0;
        waitingForOkRef.current = false;
        isSimulatingRef.current = true;
        setIsSimulating(true);
        setHighlightedBlockId(null);

        // Send first line
        sendNextGcodeLine();
    };

    const handleDownloadGcode = () => {
        if (workspaceBlocks.length === 0) {
            alert("Workspace empty! Please add blocks before downloading.");
            return;
        }
        setShowDownloadOptions(true);
    };

    const handleSaveToPC = () => {
        const gcode = generateGcode();

        // Download the G-code file
        const blob = new Blob([gcode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `pickandplace_${Date.now()}.gcode`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        setShowDownloadOptions(false);
        alert(`G-Code saved to PC successfully!\n\n${workspaceBlocks.length} block(s) processed.`);
    };

    const handleSendToDevice = async () => {
        setShowDownloadOptions(false);

        if (connectionStatus !== 'connected') {
            alert("Not connected to ESP. Please connect first.");
            return;
        }

        if (!espInfo || !espInfo.baseUrl) {
            alert("ESP device information (base URL) not available.");
            return;
        }

        const gcodeContent = generateGcode();
        if (!gcodeContent || workspaceBlocks.length === 0) {
            alert("No G-code to send. Please add blocks to the workspace.");
            return;
        }

        // Create a File object from the G-code string
        const blob = new Blob([gcodeContent], { type: 'text/plain' });
        const gcodeFile = new File([blob], `pickandplace_${Date.now()}.gcode`, { type: 'text/plain' });

        try {
            await uploadGcodeFile(espInfo.baseUrl, gcodeFile, 'pick&place');
            alert("G-Code sent to device successfully!");
        } catch (error) {
            console.error("Failed to send G-Code to device:", error);
            alert(`Failed to send G-Code to device: ${error.message || error}`);
        }
    };

    // Popup drag handlers
    const handlePopupMouseDown = (e) => {
        if (!popupRef.current || !popupHeaderRef.current) return;
        if (!popupHeaderRef.current.contains(e.target)) return;

        setIsDragging(true);
        const rect = popupRef.current.getBoundingClientRect();
        setDragOffset({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
    };

    const handlePopupMouseMove = (e) => {
        if (!isDragging || !popupRef.current) return;

        const popup = popupRef.current;
        const popupRect = popup.getBoundingClientRect();
        const popupWidth = popupRect.width;
        const popupHeight = popupRect.height;

        // Calculate new position
        let newX = e.clientX - dragOffset.x;
        let newY = e.clientY - dragOffset.y;

        // Constrain to window boundaries
        const minX = 0;
        const minY = 0;
        const maxX = window.innerWidth - popupWidth;
        const maxY = window.innerHeight - popupHeight;

        // Clamp values
        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(minY, Math.min(maxY, newY));

        setPopupPosition({
            x: newX,
            y: newY
        });
    };

    const handlePopupMouseUp = () => {
        setIsDragging(false);
    };

    // Attach drag event listeners for popup
    useEffect(() => {
        if (isDragging) {
            document.addEventListener('mousemove', handlePopupMouseMove);
            document.addEventListener('mouseup', handlePopupMouseUp);
            return () => {
                document.removeEventListener('mousemove', handlePopupMouseMove);
                document.removeEventListener('mouseup', handlePopupMouseUp);
            };
        }
    }, [isDragging, dragOffset]);

    // Extension popup drag handlers
    const handleExtensionPopupMouseDown = (e) => {
        if (!extensionPopupRef.current || !extensionHeaderRef.current) return;
        if (!extensionHeaderRef.current.contains(e.target)) return;

        setIsDraggingExtension(true);
        const rect = extensionPopupRef.current.getBoundingClientRect();
        setExtensionDragOffset({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
    };

    const handleExtensionPopupMouseMove = (e) => {
        if (!isDraggingExtension || !extensionPopupRef.current) return;

        const popup = extensionPopupRef.current;
        const popupRect = popup.getBoundingClientRect();
        const popupWidth = popupRect.width;
        const popupHeight = popupRect.height;

        // Calculate new position
        let newX = e.clientX - extensionDragOffset.x;
        let newY = e.clientY - extensionDragOffset.y;

        // Constrain to window boundaries
        const minX = 0;
        const minY = 0;
        const maxX = window.innerWidth - popupWidth;
        const maxY = window.innerHeight - popupHeight;

        // Clamp values
        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(minY, Math.min(maxY, newY));

        setExtensionPopupPosition({
            x: newX,
            y: newY
        });
    };

    const handleExtensionPopupMouseUp = () => {
        setIsDraggingExtension(false);
    };

    // Attach drag event listeners for extension popup
    useEffect(() => {
        if (isDraggingExtension) {
            document.addEventListener('mousemove', handleExtensionPopupMouseMove);
            document.addEventListener('mouseup', handleExtensionPopupMouseUp);
            return () => {
                document.removeEventListener('mousemove', handleExtensionPopupMouseMove);
                document.removeEventListener('mouseup', handleExtensionPopupMouseUp);
            };
        }
    }, [isDraggingExtension, extensionDragOffset]);

    // Clear highlight after 3 seconds
    useEffect(() => {
        if (highlightedBlockId) {
            const timer = setTimeout(() => {
                setHighlightedBlockId(null);
            }, 3000);
            return () => clearTimeout(timer);
        }
    }, [highlightedBlockId]);

    // --- Motion UI Logic ---
    const updateCoords = useCallback(() => {
        setTempState(s => ({
            ...s,
            x: Math.round(s.x * 10) / 10,
            y: Math.round(s.y * 10) / 10,
            z: Math.round(s.z * 10) / 10,
        }));
    }, []);


    const applyJoy = useCallback(() => {
        const { dx, dy } = joyStickPosRef.current;
        const step = parseFloat(document.querySelector('input[name="step"]:checked')?.value || '1');
        setTempState(s => {
            let newX = s.x + dx * step;
            let newY = s.y + dy * -step; // Invert Y

            newX = Math.max(-250, Math.min(250, newX));
            newY = Math.max(0, Math.min(300, newY));

            return { ...s, x: newX, y: newY };
        });
    }, []);


    const handleJoyMouseDown = (e) => {
        isJoyDraggingRef.current = true;
        joyIntervalRef.current = setInterval(applyJoy, 30);
    };

    const handleJoyMouseUp = useCallback(() => {
        if (isJoyDraggingRef.current) {
            isJoyDraggingRef.current = false;
            clearInterval(joyIntervalRef.current);
            if (joyStickRef.current) joyStickRef.current.style.transform = `translate(0px,0px)`;
            joyStickPosRef.current = { dx: 0, dy: 0 };
        }
    }, [applyJoy]);

    const handleJoyMouseMove = useCallback((e) => {
        if (!isJoyDraggingRef.current || !joyBaseRef.current) return;
        const rect = joyBaseRef.current.getBoundingClientRect();
        let dx = e.clientX - (rect.left + 90);
        let dy = e.clientY - (rect.top + 90);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = 50;
        if (dist > maxDist) {
            const angle = Math.atan2(dy, dx);
            dx = Math.cos(angle) * maxDist;
            dy = Math.sin(angle) * maxDist;
        }
        if (joyStickRef.current) joyStickRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
        joyStickPosRef.current = { dx: dx / maxDist, dy: dy / maxDist };
    }, []);


    useEffect(() => {
        const handleMouseUp = () => {
            handleJoyMouseUp();
        };
        const handleMouseMove = (e) => {
            handleJoyMouseMove(e);
        };

        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('mousemove', handleMouseMove);

        return () => {
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('mousemove', handleMouseMove);
            if (joyIntervalRef.current) clearInterval(joyIntervalRef.current);
        };
    }, [handleJoyMouseUp, handleJoyMouseMove]);

    useEffect(() => {
        if (activeBlock?.type === 'motion') {
            updateCoords();
        }
    }, [tempState.x, tempState.y, tempState.z, activeBlock, updateCoords]);

    // Listen for WebSocket messages to get position updates and ok responses
    useEffect(() => {
        const handleWebSocketMessage = (event) => {
            const { message } = event.detail;
            const trimmedMsg = message ? message.trim().toLowerCase() : '';

            // Check for ok response (for simulation)
            if (isSimulatingRef.current && (trimmedMsg === 'ok' || trimmedMsg.startsWith('ok'))) {
                handleOkResponse();
            }

            // Only process position responses when modal is open for a motion block
            if (modalOpen && activeBlock?.type === 'motion') {
                const posData = parsePosResponse(message);
                if (posData) {
                    // Update tempState with machine coordinates continuously
                    setTempState(s => ({
                        ...s,
                        x: posData.machine.x,
                        y: posData.machine.y,
                        z: posData.machine.z
                    }));
                }
            }
        };

        window.addEventListener('websocket-message', handleWebSocketMessage);

        return () => {
            window.removeEventListener('websocket-message', handleWebSocketMessage);
        };
    }, [modalOpen, activeBlock, handleOkResponse]);

    // Handle modal open/close and connection status changes - start/stop polling
    useEffect(() => {
        // Start polling if modal opens for motion block and connection is available
        if (modalOpen && activeBlock?.type === 'motion' && connectionStatus === 'connected') {
            startPositionPolling();
        } else {
            // Stop polling if modal closes or connection is lost
            stopPositionPolling();
        }

        // Cleanup on unmount or when modal closes
        return () => {
            stopPositionPolling();
        };
    }, [modalOpen, activeBlock, connectionStatus]);

    const jog = (axis, dir) => {
        if (connectionStatus !== 'connected') return;

        const step = parseFloat(document.querySelector('input[name="step"]:checked')?.value || '1');
        if (isNaN(step)) return;

        // Calculate new absolute position based on current fetched position + step
        const increment = dir * step;
        const currentPos = tempState[axis] || 0;
        const newPos = parseFloat((currentPos + increment).toFixed(1));

        // Clamp Z axis if needed
        let clampedPos = newPos;
        if (axis === 'z') {
            clampedPos = Math.max(0, Math.min(200, newPos));
        }

        // Send absolute move command
        const axisUpper = axis.toUpperCase();
        const gcode = `G0 ${axisUpper}${clampedPos.toFixed(1)}`;
        sendGcode(gcode);
    };

    const renderModalContent = () => {
        if (!activeBlock) return null;

        const { type } = activeBlock;

        switch (type) {
            case 'motion':
                return (
                    <div id="ui-motion" className="view-section active">
                        <div className="mode-toggle">
                            <button className={`mode-btn ${motionMode === 'joy' ? 'active' : ''}`} onClick={() => setMotionMode('joy')}>Joystick</button>
                            <button className={`mode-btn ${motionMode === 'btn' ? 'active' : ''}`} onClick={() => setMotionMode('btn')}>Buttons</button>
                        </div>

                        {motionMode === 'joy' ? (
                            <div className="joystick-group" style={{ flexDirection: 'column', gap: '20px' }}>
                                <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                                    <div className="joystick-base" ref={joyBaseRef} onMouseDown={handleJoyMouseDown}>
                                        <div className="joystick-stick" ref={joyStickRef}></div>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                        <button className="btn-dpad" style={{ width: '60px' }} onMouseDown={() => jog('z', -1)}>Z▲</button>
                                        <button className="btn-dpad" style={{ width: '60px' }} onMouseDown={() => jog('z', 1)}>Z▼</button>
                                    </div>
                                </div>
                                <div className="step-selector">
                                    <span className="step-label">Step:</span>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="0.1" />
                                        <span>0.1</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="1" defaultChecked />
                                        <span>1</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="10" />
                                        <span>10</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="100" />
                                        <span>100</span>
                                    </label>
                                </div>
                            </div>
                        ) : (
                            <div className="joystick-group" style={{ flexDirection: 'column' }}>
                                <div style={{ display: 'flex', gap: '20px' }}>
                                    <div className="dpad-grid">
                                        <div className="btn-dpad u" onMouseDown={() => jog('y', 1)}>▲</div>
                                        <div className="btn-dpad l" onMouseDown={() => jog('x', -1)}>◀</div>
                                        <div className="btn-dpad r" onMouseDown={() => jog('x', 1)}>▶</div>
                                        <div className="btn-dpad d" onMouseDown={() => jog('y', -1)}>▼</div>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                        <button className="btn-dpad" style={{ width: '60px' }} onMouseDown={() => jog('z', -1)}>Z▲</button>
                                        <button className="btn-dpad" style={{ width: '60px' }} onMouseDown={() => jog('z', 1)}>Z▼</button>
                                    </div>
                                </div>
                                <div className="step-selector">
                                    <span className="step-label">Step:</span>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="0.1" />
                                        <span>0.1</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="1" defaultChecked />
                                        <span>1</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="10" />
                                        <span>10</span>
                                    </label>
                                    <label className="radio-label">
                                        <input type="radio" name="step" value="100" />
                                        <span>100</span>
                                    </label>
                                </div>
                            </div>
                        )}

                        <div className="coord-display">
                            X:<span>{(tempState.x || 0).toFixed(1)}</span> Y:<span>{(tempState.y || 0).toFixed(1)}</span> Z:<span>{(tempState.z || 0).toFixed(1)}</span>
                        </div>
                    </div>
                );
            case 'vacuum':
                return (
                    <div id="ui-vacuum" className="view-section active">
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'white', marginBottom: '10px' }}>
                            {tempState.on ? 'ON' : 'OFF'}
                        </div>
                        <button className={`power-btn ${tempState.on ? 'on' : ''}`} onClick={() => {
                            const newOnState = !tempState.on;
                            setTempState(s => ({ ...s, on: newOnState }));
                            if (connectionStatus === 'connected') {
                                sendGcode(newOnState ? 'M05' : 'M03');
                            }
                        }}>⏻</button>
                    </div>
                );
            default: return null;
        }
    };

    const modalTitle = activeBlock ?
        activeBlock.type === 'motion' ? "Set Coordinates" : "Vacuum Settings"
        : "";

    return (
        <>
            <style>{styles}</style>
            <div className="roboblock-studio-body">
                <div id="main-container">
                    <div id="palette">
                        <div className="palette-header">Logic Blocks</div>
                        {PALETTE_BLOCKS.map(block => (
                            <div key={block.type} className={`block block-${block.type}`} draggable="true" onDragStart={(e) => handleDragStart(e, block)}>
                                <span>{block.label}</span>
                                <span style={{ fontSize: '20px' }}>{block.icon}</span>
                            </div>
                        ))}
                    </div>
                    <div id="workspace" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
                        <div className="workspace-header">
                            <h3>Workspace</h3>
                            <div className="workspace-header-buttons">
                                <button
                                    className="gcode-toggle-btn"
                                    onClick={() => setShowGcodePopup(!showGcodePopup)}
                                    title="Show G-Code"
                                >
                                    G-Code
                                </button>
                                <button
                                    className="run-btn"
                                    onClick={handleDownloadGcode}
                                    title="Download G-Code"
                                    disabled={workspaceBlocks.length === 0}
                                >
                                    Download G-Code
                                </button>
                            </div>
                        </div>
                        <div className="workspace-content">
                            <div className="workspace-blocks-list">
                                {workspaceBlocks.length === 0 ? (
                                    <div id="workspace-hint">Drag blocks here...</div>
                                ) : (
                                    workspaceBlocks.map((block, index) => {
                                        const isHighlighted = highlightedBlockId === block.id;
                                        return (
                                            <div
                                                key={block.id}
                                                className={`block workspace-block block-${block.type} ${isHighlighted ? 'highlighted' : ''}`}
                                                onClick={() => openModal(block)}
                                                ref={isHighlighted ? (el) => {
                                                    if (el) {
                                                        setTimeout(() => {
                                                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                        }, 100);
                                                    }
                                                } : null}
                                            >
                                                <span className="block-number">{index + 1}</span>
                                                <span>{PALETTE_BLOCKS.find(b => b.type === block.type).label}</span>
                                                <div className="block-params">{getBlockLabel(block)}</div>
                                                <span className="delete-btn" onClick={(e) => handleDeleteBlock(e, block.id)}>×</span>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                            <div className="workspace-stats-panel">
                                <div className="stats-header">
                                    <h4>Statistics</h4>
                                </div>
                                <div className="stats-content">
                                    <div className="stat-item">
                                        <span className="stat-label">Total Blocks</span>
                                        <span className="stat-value">{workspaceBlocks.length}</span>
                                    </div>
                                    <div className="stat-item">
                                        <span className="stat-label">Block Types</span>
                                        <div className="stat-breakdown">
                                            {['motion', 'vacuum'].map(type => {
                                                const count = workspaceBlocks.filter(b => b.type === type).length;
                                                const blocksOfType = workspaceBlocks
                                                    .map((block, index) => ({ block, index: index + 1 }))
                                                    .filter(({ block }) => block.type === type);
                                                const isSelected = selectedBlockType === type;
                                                return (
                                                    <div key={type}>
                                                        <div
                                                            className={`breakdown-item ${isSelected ? 'selected' : ''}`}
                                                            onClick={() => {
                                                                if (count > 0) {
                                                                    setSelectedBlockType(isSelected ? null : type);
                                                                    if (!isSelected) {
                                                                        // Set initial position for popup
                                                                        const rect = document.querySelector('.workspace-stats-panel')?.getBoundingClientRect();
                                                                        if (rect) {
                                                                            const popupWidth = 300; // Approximate width
                                                                            const popupHeight = Math.min(400, blocksOfType.length * 30 + 60); // Approx height
                                                                            let initialX = rect.right + 20;
                                                                            let initialY = rect.top + 100;

                                                                            // Ensure popup stays within window bounds
                                                                            if (initialX + popupWidth > window.innerWidth - 20) {
                                                                                initialX = rect.left - popupWidth - 20; // Show on left side instead
                                                                                if (initialX < 20) initialX = 20;
                                                                            }
                                                                            if (initialY + popupHeight > window.innerHeight - 20) {
                                                                                initialY = window.innerHeight - popupHeight - 20;
                                                                                if (initialY < 20) initialY = 20;
                                                                            }

                                                                            setExtensionPopupPosition({
                                                                                x: initialX,
                                                                                y: initialY
                                                                            });
                                                                        }
                                                                    }
                                                                }
                                                            }}
                                                            style={{ cursor: count > 0 ? 'pointer' : 'default' }}
                                                        >
                                                            <span className="breakdown-label">{PALETTE_BLOCKS.find(b => b.type === type)?.label || type}</span>
                                                            <span className="breakdown-count">{count}</span>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="stat-item">
                                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                                            <input
                                                type="number"
                                                min="1"
                                                value={simulationCount}
                                                onChange={(e) => setSimulationCount(Math.max(1, parseInt(e.target.value) || 1))}
                                                title="Number of loops"
                                                style={{
                                                    width: '60px',
                                                    padding: '10px',
                                                    background: 'rgba(255, 255, 255, 0.1)',
                                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                                    borderRadius: '6px',
                                                    color: 'white',
                                                    textAlign: 'center',
                                                    fontWeight: 'bold',
                                                    fontSize: '13px'
                                                }}
                                                disabled={isSimulating}
                                            />
                                            <button
                                                className="simulate-btn"
                                                style={{ marginTop: 0, flex: 1 }}
                                                onClick={handleSimulate}
                                                disabled={workspaceBlocks.length === 0 || isSimulating || connectionStatus !== 'connected'}
                                            >
                                                {isSimulating ? 'Running...' : 'Simulate'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {modalOpen && (
                    <div id="modal-overlay">
                        <div className="control-panel">
                            <h3 className="panel-header">{modalTitle}</h3>
                            {renderModalContent()}
                            <button className="save-btn" onClick={saveBlockSettings}>Save Configuration</button>
                        </div>
                    </div>
                )}

                {/* Block Type Extension Popup */}
                {selectedBlockType && workspaceBlocks.filter(b => b.type === selectedBlockType).length > 0 && (
                    <div
                        className="extension-popup"
                        ref={extensionPopupRef}
                        style={{
                            left: `${extensionPopupPosition.x}px`,
                            top: `${extensionPopupPosition.y}px`
                        }}
                        onMouseDown={handleExtensionPopupMouseDown}
                    >
                        <div className="extension-popup-header" ref={extensionHeaderRef}>
                            <h4>{PALETTE_BLOCKS.find(b => b.type === selectedBlockType)?.label || selectedBlockType}</h4>
                            <div className="extension-popup-controls">
                                <button
                                    className="extension-close-btn"
                                    onClick={() => {
                                        setSelectedBlockType(null);
                                        setHighlightedBlockId(null);
                                    }}
                                    title="Close"
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                        <div className="extension-popup-content">
                            {workspaceBlocks
                                .map((block, index) => ({ block, index: index + 1 }))
                                .filter(({ block }) => block.type === selectedBlockType)
                                .map(({ block, index }) => (
                                    <div
                                        key={block.id}
                                        className="extension-item"
                                        onClick={() => {
                                            setHighlightedBlockId(block.id);
                                        }}
                                        style={{ cursor: 'pointer' }}
                                    >
                                        <span className="extension-number">#{index}</span>
                                        <span className="extension-details">{getBlockLabel(block)}</span>
                                    </div>
                                ))}
                        </div>
                    </div>
                )}

                {/* G-Code Popup */}
                {showGcodePopup && (
                    <div
                        className="gcode-popup"
                        ref={popupRef}
                        style={{
                            left: `${popupPosition.x}px`,
                            top: `${popupPosition.y}px`
                        }}
                        onMouseDown={handlePopupMouseDown}
                    >
                        <div className="gcode-popup-header" ref={popupHeaderRef}>
                            <h4>Generated G-Code</h4>
                            <div className="gcode-popup-controls">
                                <span className="gcode-count">{workspaceBlocks.length} block{workspaceBlocks.length !== 1 ? 's' : ''}</span>
                                <button
                                    className="gcode-close-btn"
                                    onClick={() => setShowGcodePopup(false)}
                                    title="Close"
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                        <div className="gcode-popup-content">
                            {workspaceBlocks.length === 0 ? (
                                <div className="gcode-empty">No blocks in workspace yet</div>
                            ) : (
                                <div className="gcode-list">
                                    {generateGcode().split('\n').filter(line => line.trim()).map((line, index) => (
                                        <div key={index} className="gcode-line">
                                            <span className="gcode-line-num">N{index + 1}</span>
                                            <span className="gcode-command">{line}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Download Options Modal */}
                {showDownloadOptions && (
                    <div id="modal-overlay" onClick={() => setShowDownloadOptions(false)}>
                        <div className="download-options-modal" onClick={(e) => e.stopPropagation()}>
                            <h3 className="download-options-header">Download G-Code</h3>
                            <div className="download-options-content">
                                <p>Choose how you want to proceed:</p>
                                <div className="download-options-buttons">
                                    <button
                                        className="download-option-btn save-pc-btn"
                                        onClick={handleSaveToPC}
                                    >
                                        Save to PC
                                    </button>
                                    <button
                                        className="download-option-btn send-device-btn"
                                        onClick={handleSendToDevice}
                                    >
                                        Send to Device
                                    </button>
                                </div>
                            </div>
                            <button
                                className="download-options-close"
                                onClick={() => setShowDownloadOptions(false)}
                            >
                                ×
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}

export default PickAndPlacePage;
