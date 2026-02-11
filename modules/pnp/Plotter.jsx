import React, { useState, useEffect, useRef, useCallback } from 'react';
import Header from '../components/Header';

// --- Configuration ---
const DEFAULT_SETTINGS = {
  // Dimensions (mm)
  width: 100,
  height: 100,
  keepProportions: true,
  scale: 1, // Internal scale factor
  
  // Positioning
  posX: 5,
  posY: 5,
  
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
  const [fileName, setFileName] = useState('plot');
  const [paths, setPaths] = useState([]); // Array of polylines (arrays of points {x,y})
  
  // View State: x/y for panning the bed, scale for zoom
  const [view, setView] = useState({ x: 0, y: 0, scale: 2.0 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalSize, setOriginalSize] = useState({ w: 100, h: 100 });

  // --- Interaction State ---
  const [dragMode, setDragMode] = useState('NONE'); // 'NONE', 'VIEW', 'IMAGE'
  const lastMousePos = useRef({ x: 0, y: 0 });

  // --- Refs ---
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);
  const hiddenSvgRef = useRef(null); // For parsing path geometry

  // --- Helpers ---
  const round = (num) => Math.round(num * 1000) / 1000;

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
    
    // Set initial dimensions to original size (converted roughly to mm if possible, otherwise 1:1)
    setSettings(prev => ({
        ...prev,
        width: round(origW),
        height: round(origH),
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

  // --- Logic: Preview Rendering ---
  useEffect(() => {
    if (!canvasRef.current || paths.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Scale Factor = settings.width / originalSize.w
    const scaleFactorX = settings.width / originalSize.w;
    const scaleFactorY = settings.height / originalSize.h;
    
    // Resolution for canvas (higher for crispness)
    const renderScale = 2; 
    canvas.width = settings.width * renderScale;
    canvas.height = settings.height * renderScale;
    
    ctx.scale(renderScale, renderScale);
    ctx.clearRect(0, 0, settings.width, settings.height);
    
    // Style
    ctx.strokeStyle = "#2563eb"; // Blue lines
    ctx.lineWidth = 0.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    paths.forEach(poly => {
        if (poly.length < 2) return;
        ctx.beginPath();
        // Move to first point (scaled)
        ctx.moveTo(poly[0].x * scaleFactorX, poly[0].y * scaleFactorY);
        
        for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x * scaleFactorX, poly[i].y * scaleFactorY);
        }
        ctx.stroke();
    });

  }, [paths, settings.width, settings.height, originalSize]);


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
      setSettings(prev => {
          const next = { ...prev, [key]: value };
          
          // Proportional Scaling Logic
          if (prev.keepProportions && originalSize.w > 0) {
              const aspect = originalSize.w / originalSize.h;
              if (key === 'width') next.height = round(value / aspect);
              if (key === 'height') next.width = round(value * aspect);
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
        // Adjust image position relative to zoom scale
        setSettings(prev => ({
            ...prev,
            posX: Math.max(0, round(prev.posX + dx / view.scale)),
            posY: Math.max(0, round(prev.posY + dy / view.scale))
        }));
    }
  };

  const handleMouseUp = () => {
    setDragMode('NONE');
  };

  return (
    <div className="app-container" style={{ position: 'relative', zIndex: 0, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: '"Segoe UI", Arial, sans-serif', backgroundColor: '#1e1e1e', color: '#eee' }}>
      <style>{`
        .app-container::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-image: url('/background_image.png');
          background-size: 100% 100%;
          background-position: center;
          background-repeat: no-repeat;
          z-index: -2;
        }
        .app-container::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(255, 255, 255, 0.15);
          z-index: -1;
        }
        :root { --accent: #007acc; --border: #ccc; }
        .icon-btn { width: 32px; height: 32px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #ccc; cursor: pointer; border-radius: 6px; font-size: 16px; display: flex; justify-content: center; align-items: center; transition: all 0.2s ease; }
        .icon-btn:hover, .icon-btn.active { background-color: var(--accent); color: white; border-color: transparent; box-shadow: 0 0 10px rgba(0,122,204,0.6); transform: translateY(-1px); }
        .control-group { margin-bottom: 8px; overflow: hidden; line-height: 24px; border-bottom: 1px solid #ccc; padding-bottom: 4px; color: #333; }
        .control-group label { font-size: 13px; float: left; font-weight: 500; }
        .control-group input, .control-group select { float: right; width: 80px; padding: 2px; border: 1px solid #ccc; border-radius: 2px; background: rgba(255,255,255,0.9); color: #333;}
        .control-group input[type=checkbox] { float: right; width: auto; }
        .section-header { font-weight: bold; margin-top: 15px; margin-bottom: 5px; color: var(--accent); text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        .full-width-btn { width: 100%; padding: 10px; background-color: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; margin-top: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
        .full-width-btn:disabled { background-color: #999; cursor: not-allowed; box-shadow: none; }
      `}</style>

      {/* Hidden Div for Parsing */}
      <div ref={hiddenSvgRef} style={{ position: 'absolute', width: 0, height: 0, visibility: 'hidden', pointerEvents: 'none' }} />

      {/* HEADER */}
      {typeof Header !== 'undefined' && <Header showButtons={false} disableNavigation={false} />}

      {/* MAIN CONTAINER */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative', marginTop: '72px', backgroundColor: 'transparent' }}>

        {/* LEFT TOOLBAR */}
        <div style={{ width: '50px', background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '15px', zIndex: 10, boxShadow: '5px 5px 15px rgba(0,0,0,0.2)', margin: '15px', borderRadius: '8px', position: 'relative', paddingBottom: '15px' }}>
          <label className="icon-btn" title="Upload SVG">
            &#128193;
            <input ref={fileInputRef} type="file" accept=".svg" onChange={handleFile} style={{ display: 'none' }} />
          </label>
          <button className="icon-btn" title="Reset" onClick={() => { setSettings(DEFAULT_SETTINGS); setPaths([]); setSvgContent(null); setView({ x: 0, y: 0, scale: 2 }); }}>&#10227;</button>
          <div style={{ flexGrow: 1 }} />
        </div>

        {/* WORKSPACE CENTER */}
        <div
          id="workspace-center"
          ref={containerRef}
          className="workspace-center"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ flexGrow: 1, backgroundColor: 'transparent', position: 'relative', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center', userSelect: 'none', cursor: dragMode === 'VIEW' ? 'grabbing' : 'grab' }}
        >
          <div
            id="machineBed"
            style={{
              width: `${500 * view.scale}px`,
              height: `${300 * view.scale}px`,
              backgroundColor: '#e8e8e8',
              boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
              position: 'absolute',
              transform: 'translate(-50%, -50%)',
              left: `calc(50% + ${view.x}px)`,
              top: `calc(50% + ${view.y}px)`,
              backgroundImage: 'linear-gradient(#d0d0d0 1px, transparent 1px), linear-gradient(90deg, #d0d0d0 1px, transparent 1px)',
              backgroundSize: `${10 * view.scale}px ${10 * view.scale}px`,
              backgroundPosition: 'center bottom',
              transition: dragMode === 'NONE' ? 'width 0.1s, height 0.1s' : 'none',
            }}
          >
            <div id="yAxis" style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 0, borderLeft: '2px solid #e74c3c', zIndex: 0, pointerEvents: 'none' }} />
            <div id="xAxis" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 0, borderBottom: '2px solid #2ecc71', zIndex: 0, pointerEvents: 'none' }} />

            {paths.length > 0 && (
              <div
                onMouseDown={handleImageMouseDown}
                style={{
                  position: 'absolute',
                  left: `${settings.posX * view.scale}px`,
                  top: `${settings.posY * view.scale}px`,
                  width: `${settings.width * view.scale}px`,
                  height: `${settings.height * view.scale}px`,
                  border: '1px dashed #007acc',
                  zIndex: 5,
                  cursor: 'move',
                }}
              >
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
              </div>
            )}

            {!paths.length && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: '14px', pointerEvents: 'none' }}>
                Load an SVG
              </div>
            )}
          </div>
        </div>

        {/* RIGHT SETTINGS */}
        <div style={{ width: '350px', minWidth: '350px', background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '-5px 5px 15px rgba(0,0,0,0.15)', zIndex: 15, margin: '15px', borderRadius: '8px', height: 'calc(100% - 30px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

          {paths.length === 0 && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(255,255,255,0.6)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', color: '#333', backdropFilter: 'blur(3px)', textShadow: '0 1px 2px rgba(255,255,255,0.8)' }}>
              Load an SVG to edit
            </div>
          )}

          <div style={{ padding: '15px', overflowY: 'auto', flexGrow: 1 }}>
            <button className="full-width-btn" onClick={generateGCode} disabled={paths.length === 0 || isProcessing}>
              {isProcessing ? 'PROCESSING...' : 'GENERATE G-CODE'}
            </button>
            <br /><br />

            <div className="section-header">Dimensiaoisbndusbons (mm)</div>
            <div className="control-group"><label>Width:</label><input type="number" value={settings.width} onChange={(e) => updateSetting('width', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Height:</label><input type="number" value={settings.height} onChange={(e) => updateSetting('height', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Keep proportions:</label><input type="checkbox" checked={settings.keepProportions} onChange={(e) => updateSetting('keepProportions', e.target.checked)} /></div>

            <div className="section-header">Position (mm)</div>
            <div className="control-group"><label>Pos X:</label><input type="number" value={settings.posX} onChange={(e) => updateSetting('posX', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Pos Y:</label><input type="number" value={settings.posY} onChange={(e) => updateSetting('posY', parseFloat(e.target.value) || 0)} /></div>

            <div className="section-header">Plotter setup</div>
            <div className="control-group"><label>Z Up:</label><input type="number" value={settings.zUp} onChange={(e) => updateSetting('zUp', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Z Down:</label><input type="number" value={settings.zDown} onChange={(e) => updateSetting('zDown', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Work Speed:</label><input type="number" value={settings.workSpeed} onChange={(e) => updateSetting('workSpeed', parseFloat(e.target.value) || 0)} /></div>
            <div className="control-group"><label>Travel Speed:</label><input type="number" value={settings.travelSpeed} onChange={(e) => updateSetting('travelSpeed', parseFloat(e.target.value) || 0)} /></div>

            <div style={{ fontSize: '10px', color: '#666', marginTop: '15px', textAlign: 'center' }}>
              Import .SVG files only. Paths are traced as lines (vectors).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
