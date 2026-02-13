import React, { useState, useEffect, useRef, useCallback } from 'react';
import './Plotter.css';

// --- Configuration ---
// Bed: origin (0,0) at bottom center; X from -250 (left) to +250 (right); Y from 0 (bottom) to 300 (top)
const BED_WIDTH_MM = 500;
const BED_HEIGHT_MM = 300;
const BED_CENTER_X_MM = 250; // 0,0 is at center of X

const DEFAULT_SETTINGS = {
  // Dimensions (mm)
  width: 100,
  height: 100,
  keepProportions: true,
  scale: 1, // Internal scale factor
  
  // Positioning (posX: -250 to +250 from center, posY: 0 = bottom)
  posX: 0,
  posY: 0,
  
  // Plotter Settings
  zUp: 5.0,
  zDown: 0.0,
  workSpeed: 1000,
  travelSpeed: 6000,
  
  // Quality
  curveResolution: 0.5, // mm per segment for curves
};

export default function VectorPlotter() {
  // --- State ---
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [svgContent, setSvgContent] = useState(null);
  const [svgPreviewUrl, setSvgPreviewUrl] = useState(null); // Blob URL to show exact SVG image in workspace
  const [fileName, setFileName] = useState('plot');
  const [paths, setPaths] = useState([]); // Array of polylines (arrays of points {x,y}) - used for G-code only
  
  // View State: x/y for panning the bed, scale for zoom
  const [view, setView] = useState({ x: 0, y: 0, scale: 2.0 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalSize, setOriginalSize] = useState({ w: 100, h: 100 });

  // --- Interaction State ---
  const [dragMode, setDragMode] = useState('NONE'); // 'NONE', 'VIEW', 'IMAGE'
  const lastMousePos = useRef({ x: 0, y: 0 });

  // --- Refs ---
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);
  const hiddenSvgRef = useRef(null); // For parsing path geometry

  // --- Helpers (1 decimal place for settings) ---
  const round = (num) => Math.round(num * 10) / 10;
  const round1 = (num) => (typeof num === 'number' && !Number.isNaN(num) ? Math.round(num * 10) / 10 : num);

  // Create blob URL so workspace can show the exact SVG image (not just extracted paths)
  useEffect(() => {
    if (!svgContent) {
      setSvgPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([svgContent], { type: 'image/svg+xml' }));
    setSvgPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [svgContent]);

  // --- SVG Parsing Engine ---
  const parseSVG = (svgText) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    
    if (!svgEl) return alert("Invalid SVG file");

    // 1. Determine Original Size
    let viewBox = svgEl.getAttribute("viewBox");
    let origW, origH;

    if (viewBox) {
        const vb = viewBox.split(/\s+|,/).filter(Boolean).map(parseFloat);
        origW = vb[2];
        origH = vb[3];
    } else {
        // Fallback to width/height attributes, stripping 'px', 'mm' etc
        origW = parseFloat(svgEl.getAttribute("width")) || 100;
        origH = parseFloat(svgEl.getAttribute("height")) || 100;
    }
    
    setOriginalSize({ w: origW, h: origH });
    
    // Set initial width to 100 (mm), height scaled to keep aspect ratio
    const initialWidth = 100;
    const initialHeight = origW > 0 ? round(initialWidth * (origH / origW)) : initialWidth;
    setSettings(prev => ({
        ...prev,
        width: initialWidth,
        height: initialHeight,
        scale: 1
    }));

    // 2. Flatten and Extract Paths
    if (hiddenSvgRef.current) {
        hiddenSvgRef.current.innerHTML = svgText;
        const svgDom = hiddenSvgRef.current.querySelector('svg');
        
        // Ensure standard units for calculation
        svgDom.setAttribute('width', '100%');
        svgDom.setAttribute('height', '100%');

        const extractedPaths = [];
        const precision = 1; // Sample every 1 unit (internal SVG units)

        // Helper: Sample a path element and Apply Transforms
        const samplePath = (pathEl, originalEl = null) => {
            const len = pathEl.getTotalLength();
            if (len <= 0) return;

            // Get the Transformation Matrix (CTM) of the original element
            // This handles <g transform="...">, rotate, scale, translate
            const elForMatrix = originalEl || pathEl;
            const ctm = elForMatrix.getCTM ? elForMatrix.getCTM() : null;
            
            // Handle "Move" commands (gaps) inside a single path string
            const d = pathEl.getAttribute('d') || "";
            // Robust Regex split that keeps the 'M/m' delimiter
            const subPathCmds = d.split(/(?=[Mm])/).filter(s => s.trim().length > 0);

            subPathCmds.forEach(subCmd => {
                // Create a temp path for this segment to calculate geometry
                const tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
                tempPath.setAttribute("d", subCmd);
                
                const subLen = tempPath.getTotalLength();
                const points = [];
                
                // Sample points along the curve
                for (let i = 0; i <= subLen; i += precision) {
                    const pt = tempPath.getPointAtLength(i);
                    let finalX = pt.x;
                    let finalY = pt.y;

                    // Apply Matrix Transform if available
                    if (ctm) {
                        finalX = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
                        finalY = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
                    }
                    points.push({ x: finalX, y: finalY });
                }
                
                // Add last point
                const lastPt = tempPath.getPointAtLength(subLen);
                let lastX = lastPt.x;
                let lastY = lastPt.y;
                 if (ctm) {
                    lastX = lastPt.x * ctm.a + lastPt.y * ctm.c + ctm.e;
                    lastY = lastPt.x * ctm.b + lastPt.y * ctm.d + ctm.f;
                }
                points.push({ x: lastX, y: lastY });

                if (points.length > 1) extractedPaths.push(points);
            });
        };

        const elements = svgDom.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
        
        elements.forEach(el => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'path') {
                samplePath(el);
            } else {
                try {
                    const len = el.getTotalLength();
                    const ctm = el.getCTM ? el.getCTM() : null;
                    const points = [];
                    
                    for (let i = 0; i <= len; i += precision) {
                        const pt = el.getPointAtLength(i);
                        let finalX = pt.x;
                        let finalY = pt.y;

                        if (ctm) {
                            finalX = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
                            finalY = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
                        }
                        points.push({ x: finalX, y: finalY });
                    }
                    if (points.length > 1) extractedPaths.push(points);
                } catch (e) {
                    // console.warn("Could not sample element:", el);
                }
            }
        });

        setPaths(extractedPaths);
        hiddenSvgRef.current.innerHTML = ''; // Clean up
    }
  };

  // Paths are used only for G-code generation. Workspace preview shows the exact SVG image via img + svgPreviewUrl.


  // --- Logic: G-Code Generation ---
  const generateGCode = async () => {
    if (paths.length === 0) return;
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 100)); // UI Refresh

    try {
        const gcode = [];
        const scaleX = settings.width / originalSize.w;
        const scaleY = settings.height / originalSize.h;
        
        // Header
        gcode.push(`; Generated by VectorPlotter Studio`);
        gcode.push(`; Dimensions: ${settings.width}mm x ${settings.height}mm`);
        gcode.push(`; Pen Up: ${settings.zUp}mm`);
        gcode.push(`; Pen Down: ${settings.zDown}mm`);
        gcode.push(`G90`); // Absolute positioning
        gcode.push(`G21`); // Units mm
        gcode.push(`G0 Z${settings.zUp} F${settings.travelSpeed}`); // Safe Z
        gcode.push(`G0 X0 Y0 F${settings.travelSpeed}`); // Home

        // Process Paths
        paths.forEach(poly => {
            if (poly.length < 2) return;

            // 1. Move to Start (Pen Up)
            const startX = round((poly[0].x * scaleX) + settings.posX);
            const startY = round((poly[0].y * scaleY) + settings.posY); 
            
            gcode.push(`G0 X${startX} Y${startY} F${settings.travelSpeed}`);
            
            // 2. Pen Down
            gcode.push(`G1 Z${settings.zDown} F${settings.workSpeed}`);
            
            // 3. Draw Path
            for (let i = 1; i < poly.length; i++) {
                const x = round((poly[i].x * scaleX) + settings.posX);
                const y = round((poly[i].y * scaleY) + settings.posY);
                gcode.push(`G1 X${x} Y${y} F${settings.workSpeed}`);
            }

            // 4. Pen Up
            gcode.push(`G0 Z${settings.zUp} F${settings.travelSpeed}`);
        });

        // Footer
        gcode.push(`G0 X0 Y0 F${settings.travelSpeed}`);
        gcode.push(`M2`); // End program

        // Download
        const blob = new Blob([gcode.join("\n")], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileName}_plot.gcode`;
        a.click();
        URL.revokeObjectURL(url);

    } catch (e) {
        console.error(e);
        alert("Error generating G-code");
    } finally {
        setIsProcessing(false);
    }
  };


  // --- Handlers: File & Settings ---
  const handleFile = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      if (!file.name.toLowerCase().endsWith('.svg')) {
          alert("Please select an SVG file.");
          return;
      }

      setFileName(file.name.replace('.svg', ''));
      
      const reader = new FileReader();
      reader.onload = (ev) => {
          setSvgContent(ev.target.result);
          parseSVG(ev.target.result);
      };
      reader.readAsText(file);
  };

  const updateSetting = (key, value) => {
      const numVal = typeof value === 'number' && !Number.isNaN(value) ? round1(value) : value;
      setSettings(prev => {
          const next = { ...prev, [key]: numVal };
          if (prev.keepProportions && originalSize.w > 0 && (key === 'width' || key === 'height')) {
              const aspect = originalSize.w / originalSize.h;
              if (key === 'width') next.height = round1(numVal / aspect);
              if (key === 'height') next.width = round1(numVal * aspect);
          }
          return next;
      });
  };

  // --- Handlers: Interactive Workspace ---
  
  const handleWheel = (e) => {
    // Zoom with Ctrl/Meta + Scroll (or just Scroll based on preference, sticking to robust scroll zoom)
    if (e.ctrlKey || e.metaKey || true) { // Always zoom on wheel for this 'studio' feel
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * 0.1;
        const newScale = Math.max(0.2, Math.min(view.scale + delta, 10));
        setView(prev => ({ ...prev, scale: newScale }));
    }
  };

  const handleMouseDown = (e) => {
    // Left click (button 0) triggers PAN on background, or DRAG on object
    if (e.button === 0) {
        setDragMode('VIEW'); // Default to panning view
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleImageMouseDown = (e) => {
    e.stopPropagation(); // Stop bubbling to background
    if (e.button === 0) {
        setDragMode('IMAGE');
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e) => {
    if (dragMode === 'NONE') return;

    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    if (dragMode === 'VIEW') {
        setView(prev => ({
            ...prev,
            x: prev.x + dx,
            y: prev.y + dy
        }));
    } else if (dragMode === 'IMAGE') {
        // posX: left = -250, center = 0, right = +250. posY: bottom = 0, up = +. Dragging down (dy>0) = decrease posY.
        const dxMm = dx / view.scale;
        const dyMm = -dy / view.scale;
        setSettings(prev => {
            const minX = -250;
            const maxX = 250 - prev.width;
            const minY = 0;
            const maxY = Math.max(0, 300 - prev.height);
            return {
                ...prev,
                posX: round(Math.max(minX, Math.min(maxX, prev.posX + dxMm))),
                posY: round(Math.max(minY, Math.min(maxY, prev.posY + dyMm)))
            };
        });
    }
  };

  const handleMouseUp = () => {
    setDragMode('NONE');
  };

  return (
    <div className="roboblock-studio-body">
      <div ref={hiddenSvgRef} style={{ position: 'absolute', width: 0, height: 0, visibility: 'hidden', pointerEvents: 'none' }} />

      <div id="main-container">
        {/* LEFT TOOLBAR */}
        <div className="plotter-toolbar">
          <label className="plotter-icon-btn" title="Upload SVG">
            &#128193;
            <input ref={fileInputRef} type="file" accept=".svg" onChange={handleFile} style={{ display: 'none' }} />
          </label>
          <button className="plotter-icon-btn" title="Reset" onClick={() => { setSettings(DEFAULT_SETTINGS); setPaths([]); setSvgContent(null); setView({ x: 0, y: 0, scale: 2 }); }}>&#10227;</button>
          <div style={{ flexGrow: 1 }} />
        </div>

        {/* WORKSPACE CENTER */}
        <div
          className="plotter-workspace"
          ref={containerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: dragMode === 'VIEW' ? 'grabbing' : 'grab', justifyContent: 'center', alignItems: 'center', userSelect: 'none' }}
        >
          <div
            id="machineBed"
            style={{
              width: `${500 * view.scale}px`,
              height: `${300 * view.scale}px`,
              backgroundColor: 'rgba(232,232,232,0.95)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
              position: 'absolute',
              transform: 'translate(-50%, -50%)',
              left: `calc(50% + ${view.x}px)`,
              top: `calc(50% + ${view.y}px)`,
              backgroundImage: 'linear-gradient(rgba(200,200,200,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(200,200,200,0.8) 1px, transparent 1px)',
              backgroundSize: `${10 * view.scale}px ${10 * view.scale}px`,
              backgroundPosition: 'center bottom',
              transition: dragMode === 'NONE' ? 'width 0.1s, height 0.1s' : 'none',
              borderRadius: '8px',
            }}
          >
            {/* Workspace: center bottom = 0,0; to right x+ → 250,0; to left x- → -250,0; Y 0 = bottom */}
            <div id="yAxis" style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 0, borderLeft: '2px solid #e74c3c', zIndex: 0, pointerEvents: 'none' }} />
            <div id="xAxis" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 0, borderBottom: '2px solid #2ecc71', zIndex: 0, pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', left: 4, bottom: 4, fontSize: 10, color: '#666', pointerEvents: 'none' }}>-250,0</div>
            <div style={{ position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)', fontSize: 10, color: '#666', pointerEvents: 'none' }}>0,0</div>
            <div style={{ position: 'absolute', right: 4, bottom: 4, fontSize: 10, color: '#666', pointerEvents: 'none' }}>250,0</div>

            {(svgPreviewUrl && svgContent) && (
              <div
                onMouseDown={handleImageMouseDown}
                style={{
                  position: 'absolute',
                  left: `${(BED_CENTER_X_MM + settings.posX) * view.scale}px`,
                  top: `${(BED_HEIGHT_MM - settings.posY - settings.height) * view.scale}px`,
                  width: `${settings.width * view.scale}px`,
                  height: `${settings.height * view.scale}px`,
                  border: '1px dashed var(--accent)',
                  zIndex: 5,
                  cursor: 'move',
                }}
              >
                <img
                  src={svgPreviewUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain', pointerEvents: 'none' }}
                />
              </div>
            )}

            {!svgContent && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '14px', pointerEvents: 'none' }}>
                Load an SVG
              </div>
            )}
          </div>
        </div>

        {/* RIGHT SETTINGS */}
        <div className="plotter-settings">
          {!svgContent && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', color: 'var(--text-muted)', backdropFilter: 'blur(4px)' }}>
              Load an SVG to edit
            </div>
          )}

          <div style={{ padding: '20px', overflowY: 'auto', flexGrow: 1 }}>
            <button className="plotter-full-width-btn" onClick={generateGCode} disabled={!svgContent || paths.length === 0 || isProcessing}>
              {isProcessing ? 'PROCESSING...' : 'GENERATE G-CODE'}
            </button>

            <div className="plotter-section-header">Dimensions (mm)</div>
            <div className="plotter-control-group"><label>Width:</label><input type="number" step="0.1" value={settings.width} onChange={(e) => updateSetting('width', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Height:</label><input type="number" step="0.1" value={settings.height} onChange={(e) => updateSetting('height', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Keep proportions:</label><input type="checkbox" checked={settings.keepProportions} onChange={(e) => updateSetting('keepProportions', e.target.checked)} /></div>

            <div className="plotter-section-header">Position (mm)</div>
            <div className="plotter-control-group"><label>Pos X:</label><input type="number" step="0.1" value={settings.posX} onChange={(e) => updateSetting('posX', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Pos Y:</label><input type="number" step="0.1" value={settings.posY} onChange={(e) => updateSetting('posY', parseFloat(e.target.value) || 0)} /></div>

            <div className="plotter-section-header">Plotter setup</div>
            <div className="plotter-control-group"><label>Z Up:</label><input type="number" step="0.1" value={settings.zUp} onChange={(e) => updateSetting('zUp', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Z Down:</label><input type="number" step="0.1" value={settings.zDown} onChange={(e) => updateSetting('zDown', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Work Speed:</label><input type="number" step="0.1" value={settings.workSpeed} onChange={(e) => updateSetting('workSpeed', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Travel Speed:</label><input type="number" step="0.1" value={settings.travelSpeed} onChange={(e) => updateSetting('travelSpeed', parseFloat(e.target.value) || 0)} /></div>

            <div className="plotter-hint">
              Import .SVG files only. Paths are traced as lines (vectors).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
