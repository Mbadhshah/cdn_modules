import React, { useState, useRef, useEffect, useCallback } from 'react';
import './PNP.css';
import { v4 as uuidv4 } from 'uuid';
import { useConnection } from '../context/ConnectionContext';
import { uploadGcodeFile } from '../api/gcodeUploader';

const PALETTE_BLOCKS = [
    { type: 'motion', label: 'Move to Point', icon: '✥' },
    { type: 'vacuum', label: 'Pick & Place ', icon: '◎' },
];

function PickAndPlacePage() {
    const [simulationCount, setSimulationCount] = useState(1);
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

    const getDefaultLabel = (type) => {
        if (type === 'motion') return "X:0 Y:0 Z:0";
        if (type === 'vacuum') return "OFF";
        if (type === 'orient') return "A:0 B:0 C:0";
        return "";
    };

    const getBlockLabel = (block) => {
        const { type, vals } = block;
        if (type === 'motion') return `X:${vals.x} Y:${vals.y} Z:${vals.z}`;
        if (type === 'vacuum') return vals.on ? `ON` : `OFF`;
        if (type === 'orient') return `A:${vals.a || 0} B:${vals.b || 0} C:${vals.c || 0}`;
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
            vals: droppedBlock.type === 'motion' ? { x: 0, y: 0, z: 0 } :
                droppedBlock.type === 'vacuum' ? { on: false } :
                    { a: 0, b: 0, c: 0 }
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
            if (type === 'orient') {
                gcode += `G0 A${d.a || 0} B${d.b || 0} C${d.c || 0}\n`;
            }
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
            case 'orient':
                return (
                    <div id="ui-orient" className="view-section active">
                        <div className="h-slider-group">
                            <div className="h-slider-lbl">
                                <span>Axis A</span>
                                <span>{tempState.a || 0}</span>
                            </div>
                            <input
                                type="range"
                                className="h-slider"
                                min="0"
                                max="255"
                                value={tempState.a || 0}
                                onInput={(e) => {
                                    const value = parseInt(e.target.value);
                                    setTempState(s => {
                                        const newState = { ...s, a: value };
                                        if (connectionStatus === 'connected') {
                                            const a = value;
                                            const b = newState.b || 0;
                                            const c = newState.c || 0;
                                            sendGcode(`G0 A${a} B${b} C${c}`);
                                        }
                                        return newState;
                                    });
                                }}
                            />
                        </div>
                        <div className="h-slider-group">
                            <div className="h-slider-lbl">
                                <span>Axis B</span>
                                <span>{tempState.b || 0}</span>
                            </div>
                            <input
                                type="range"
                                className="h-slider"
                                min="0"
                                max="255"
                                value={tempState.b || 0}
                                onInput={(e) => {
                                    const value = parseInt(e.target.value);
                                    setTempState(s => {
                                        const newState = { ...s, b: value };
                                        if (connectionStatus === 'connected') {
                                            const a = newState.a || 0;
                                            const b = value;
                                            const c = newState.c || 0;
                                            sendGcode(`G0 A${a} B${b} C${c}`);
                                        }
                                        return newState;
                                    });
                                }}
                            />
                        </div>
                        <div className="h-slider-group">
                            <div className="h-slider-lbl">
                                <span>Axis C</span>
                                <span>{tempState.c || 0}</span>
                            </div>
                            <input
                                type="range"
                                className="h-slider"
                                min="0"
                                max="255"
                                value={tempState.c || 0}
                                onInput={(e) => {
                                    const value = parseInt(e.target.value);
                                    setTempState(s => {
                                        const newState = { ...s, c: value };
                                        if (connectionStatus === 'connected') {
                                            const a = newState.a || 0;
                                            const b = newState.b || 0;
                                            const c = value;
                                            sendGcode(`G0 A${a} B${b} C${c}`);
                                        }
                                        return newState;
                                    });
                                }}
                            />
                        </div>
                    </div>
                );
            default: return null;
        }
    };

        const modalTitle = activeBlock ?
        activeBlock.type === 'motion' ? "Set Coordinates" : "Vacuum Settings"
        : "";

    return (
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
                                            {['motion', 'vacuum', 'orient'].map(type => {
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
    );
}

export default PickAndPlacePage;
