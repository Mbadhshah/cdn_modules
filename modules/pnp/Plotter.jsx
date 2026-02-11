import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Upload, 
  Download, 
  Settings, 
  Move, 
  PenTool, 
  RefreshCw,
  Maximize
} from 'lucide-react';

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
    <div 
        className="flex flex-col h-screen text-gray-200 font-sans overflow-hidden bg-cover bg-center"
        style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1550684848-fac1c5b4e853?q=80&w=2670&auto=format&fit=crop')`, // Dark abstract technical background
            backgroundColor: '#111' // Fallback
        }}
    >
      {/* Hidden Div for Parsing */}
      <div ref={hiddenSvgRef} style={{position:'absolute', width:0, height:0, visibility:'hidden', pointerEvents:'none'}}></div>

      {/* Header Removed */}

      <div className="flex flex-1 overflow-hidden relative">
        
        {/* Left Toolbar */}
        <div className="w-16 bg-black/40 backdrop-blur-md border-r border-white/10 flex flex-col items-center py-4 gap-4 z-10 m-4 rounded-xl shadow-2xl">
          <label className="p-3 rounded-xl bg-white/10 hover:bg-blue-600 hover:text-white transition-all cursor-pointer group tooltip-container">
            <Upload size={20} />
            <input ref={fileInputRef} type="file" accept=".svg" className="hidden" onChange={handleFile} />
          </label>
          <button onClick={() => { setSettings(DEFAULT_SETTINGS); setPaths([]); setSvgContent(null); setView({x:0, y:0, scale:2}); }} className="p-3 rounded-xl bg-white/10 hover:bg-red-500 hover:text-white transition-all">
             <RefreshCw size={20} />
          </button>
        </div>

        {/* Center Workspace */}
        <div 
            className="flex-1 relative overflow-hidden bg-transparent cursor-grab active:cursor-grabbing flex justify-center items-center"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
             {/* Transform Container (Pan & Zoom) */}
             <div 
                style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    transformOrigin: 'center center',
                    transition: dragMode === 'NONE' ? 'transform 0.1s ease-out' : 'none'
                }}
             >
                 {/* Machine Bed */}
                 <div 
                    className="bg-white/90 shadow-[0_10px_50px_rgba(0,0,0,0.8)] relative backdrop-blur-sm"
                    style={{
                        width: '500px',
                        height: '300px',
                        backgroundImage: `
                            linear-gradient(#ccc 1px, transparent 1px),
                            linear-gradient(90deg, #ccc 1px, transparent 1px)
                        `,
                        backgroundSize: '10px 10px'
                    }}
                 >
                    {/* Visual Bed Markers */}
                    <div className="absolute top-0 left-0 text-[10px] text-gray-500 p-1 select-none">0,0</div>
                    <div className="absolute bottom-1 right-1 text-gray-500 text-xs pointer-events-none select-none">500mm x 300mm</div>
                    
                    {/* Axes */}
                    <div className="absolute left-0 bottom-0 w-full h-px bg-green-600 opacity-60 pointer-events-none"></div>
                    <div className="absolute left-0 bottom-0 w-px h-full bg-red-600 opacity-60 pointer-events-none"></div>

                    {/* The Plot Preview (Draggable Object) */}
                    {paths.length > 0 && (
                        <div 
                            onMouseDown={handleImageMouseDown}
                            className="absolute border border-dashed border-blue-500 hover:border-solid cursor-move group"
                            style={{
                                left: `${settings.posX}px`,
                                top: `${settings.posY}px`,
                                width: `${settings.width}px`,
                                height: `${settings.height}px`,
                            }}
                        >
                            <canvas ref={canvasRef} className="w-full h-full block pointer-events-none" />
                            
                            {/* Position Info Tag */}
                            <div className="absolute -top-6 left-0 text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                X:{settings.posX} Y:{settings.posY}
                            </div>
                            
                            {/* Drag Handle Overlay */}
                            <div className="absolute inset-0 bg-blue-500/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                                <Move size={24} className="text-blue-500" />
                            </div>
                        </div>
                    )}
                    
                    {!paths.length && (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-400 pointer-events-none opacity-20">
                            <Upload size={64} />
                        </div>
                    )}
                 </div>
             </div>
        </div>

        {/* Right Settings Panel */}
        <div className="w-[300px] flex flex-col bg-black/40 backdrop-blur-xl border-l border-white/10 z-15 shadow-2xl text-sm">
            {/* Scrollable Settings Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                
                {/* Dimensions Group */}
                <div className="border-b border-white/10 pb-4">
                    <div className="flex items-center gap-2 mb-3 text-blue-400 font-semibold uppercase text-xs tracking-wider">
                        <Settings size={14} />
                        Dimensions (mm)
                    </div>
                    <div className="space-y-2">
                        <Control label="Width" value={settings.width} onChange={v => updateSetting('width', v)} />
                        <Control label="Height" value={settings.height} onChange={v => updateSetting('height', v)} />
                        
                        <div className="flex items-center justify-between cursor-pointer pt-2" onClick={() => updateSetting('keepProportions', !settings.keepProportions)}>
                            <label className="text-gray-300 cursor-pointer">Keep Proportions</label>
                            <div className={`w-8 h-4 rounded-full relative transition-colors ${settings.keepProportions ? 'bg-blue-600' : 'bg-gray-600'}`}>
                                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${settings.keepProportions ? 'left-4.5' : 'left-0.5'}`} style={{left: settings.keepProportions ? '18px' : '2px'}}></div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Position Group */}
                <div className="border-b border-white/10 pb-4">
                    <div className="flex items-center gap-2 mb-3 text-blue-400 font-semibold uppercase text-xs tracking-wider">
                        <Move size={14} />
                        Position (mm)
                    </div>
                    <div className="space-y-2">
                        <Control label="Pos X" value={settings.posX} onChange={v => updateSetting('posX', v)} />
                        <Control label="Pos Y" value={settings.posY} onChange={v => updateSetting('posY', v)} />
                    </div>
                </div>

                {/* Plotter Config Group */}
                <div className="border-b border-white/10 pb-4">
                    <div className="flex items-center gap-2 mb-3 text-blue-400 font-semibold uppercase text-xs tracking-wider">
                        <PenTool size={14} />
                        Plotter Setup
                    </div>
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                            <Control label="Z Up" value={settings.zUp} onChange={v => updateSetting('zUp', v)} />
                            <Control label="Z Down" value={settings.zDown} onChange={v => updateSetting('zDown', v)} />
                        </div>
                        <Control label="Work Speed" value={settings.workSpeed} onChange={v => updateSetting('workSpeed', v)} />
                        <Control label="Travel Speed" value={settings.travelSpeed} onChange={v => updateSetting('travelSpeed', v)} />
                    </div>
                </div>

                <div className="text-[10px] text-gray-400 text-center">
                    Import .SVG files only.<br/>
                    Paths are traced as lines (Vectors).<br/>
                    No raster dots.
                </div>
            </div>

            {/* Bottom Button Area */}
            <div className="p-4 border-t border-white/10 bg-black/20">
                <button 
                    disabled={paths.length === 0 || isProcessing}
                    onClick={generateGCode}
                    className={`w-full py-3 rounded font-bold flex items-center justify-center gap-2 transition-all ${paths.length === 0 ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/50'}`}
                >
                    {isProcessing ? <RefreshCw className="animate-spin" /> : <Download size={18} />}
                    {isProcessing ? 'PROCESSING...' : 'GENERATE G-CODE'}
                </button>
            </div>
        </div>

      </div>
    </div>
  );
}

// --- Subcomponents ---

function Control({ label, value, onChange }) {
    return (
        <div className="flex items-center justify-between">
            <label className="text-gray-300">{label}</label>
            <input 
                type="number" 
                className="w-20 bg-black/30 border border-white/10 rounded px-2 py-1 text-right focus:border-blue-500 outline-none transition-colors text-white placeholder-gray-500"
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            />
        </div>
    )
}
