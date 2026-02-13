import React, { useState, useEffect, useRef } from 'react';
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

function createItemId() {
  return 'plot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

// Single image block on the bed (canvas + position)
function PlotItem({ item, scale, isSelected }) {
  const canvasRef = useRef(null);
  const { paths, settings, originalSize } = item;
  useEffect(() => {
    if (!canvasRef.current || !paths || paths.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const scaleFactorX = settings.width / originalSize.w;
    const scaleFactorY = settings.height / originalSize.h;
    const renderScale = 2;
    canvas.width = settings.width * renderScale;
    canvas.height = settings.height * renderScale;
    ctx.scale(renderScale, renderScale);
    ctx.clearRect(0, 0, settings.width, settings.height);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 0.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    paths.forEach((poly) => {
      if (poly.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(poly[0].x * scaleFactorX, poly[0].y * scaleFactorY);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * scaleFactorX, poly[i].y * scaleFactorY);
      ctx.stroke();
    });
  }, [paths, settings.width, settings.height, originalSize]);
  return (
    <div
      data-plot-item
      data-id={item.id}
      style={{
        position: 'absolute',
        left: `${(BED_CENTER_X_MM + settings.posX) * scale}px`,
        top: `${(BED_HEIGHT_MM - settings.posY - settings.height) * scale}px`,
        width: `${settings.width * scale}px`,
        height: `${settings.height * scale}px`,
        border: isSelected ? '2px dashed var(--accent)' : '1px dashed rgba(255,255,255,0.3)',
        zIndex: isSelected ? 10 : 5,
        cursor: 'move',
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default function VectorPlotter() {
  // --- State: multiple images ---
  const [items, setItems] = useState([]); // [{ id, name, paths, settings, originalSize }, ...]
  const [activeId, setActiveId] = useState(null);

  // Plotter setup: common for all layers (Z Up, Z Down, Work Speed, Travel Speed)
  const [plotterSetup, setPlotterSetup] = useState({
    zUp: DEFAULT_SETTINGS.zUp,
    zDown: DEFAULT_SETTINGS.zDown,
    workSpeed: DEFAULT_SETTINGS.workSpeed,
    travelSpeed: DEFAULT_SETTINGS.travelSpeed,
  });
  
  // View State: x/y for panning the bed, scale for zoom
  const [view, setView] = useState({ x: 0, y: 0, scale: 2.0 });
  const [isProcessing, setIsProcessing] = useState(false);

  // --- Interaction State ---
  const [dragMode, setDragMode] = useState('NONE'); // 'NONE', 'VIEW', 'IMAGE'
  const lastMousePos = useRef({ x: 0, y: 0 });
  const dragItemIdRef = useRef(null);

  // --- Refs ---
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);
  const hiddenSvgRef = useRef(null); // For parsing path geometry

  const activeItem = items.find((i) => i.id === activeId);

  // --- Helpers (1 decimal place for settings) ---
  const round = (num) => Math.round(num * 10) / 10;
  const round1 = (num) => (typeof num === 'number' && !Number.isNaN(num) ? Math.round(num * 10) / 10 : num);

  // --- SVG Parsing Engine (returns { paths, origW, origH } or null) ---
  const parseSVG = (svgText) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) return null;

    let viewBox = svgEl.getAttribute("viewBox");
    let origW, origH;
    if (viewBox) {
      const vb = viewBox.split(/\s+|,/).filter(Boolean).map(parseFloat);
      origW = vb[2];
      origH = vb[3];
    } else {
      origW = parseFloat(svgEl.getAttribute("width")) || 100;
      origH = parseFloat(svgEl.getAttribute("height")) || 100;
    }

    if (!hiddenSvgRef.current) return { paths: [], origW, origH };
    hiddenSvgRef.current.innerHTML = svgText;
    const svgDom = hiddenSvgRef.current.querySelector('svg');
    if (!svgDom) return { paths: [], origW, origH };

        svgDom.setAttribute('width', '100%');
        svgDom.setAttribute('height', '100%');

        const extractedPaths = [];
        const precision = 0.5; // Finer sampling for smoother curves and fewer missed segments
        const NS = "http://www.w3.org/2000/svg";

        const getRefId = (useEl) => {
            const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
            const m = href.match(/#([^#]+)/);
            return m ? m[1] : href.replace(/^#/, '');
        };

        // Resolve <use href="#id">: clone referenced element into a temp group with use's transform so getCTM() is correct
        const tempGroups = [];
        const allUse = svgDom.querySelectorAll('use');
        allUse.forEach((useEl) => {
            if (useEl.closest('defs')) return;
            const id = getRefId(useEl);
            if (!id) return;
            const ref = svgDom.querySelector('[id="' + id + '"]') || document.getElementById(id);
            if (!ref) return;
            const tag = ref.tagName.toLowerCase();
            const supported = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'symbol'];
            if (!supported.includes(tag)) return;

            const useX = parseFloat(useEl.getAttribute('x')) || 0;
            const useY = parseFloat(useEl.getAttribute('y')) || 0;
            let transform = `translate(${useX},${useY})`;
            const tr = useEl.getAttribute('transform');
            if (tr) transform = tr + ' ' + transform;

            const group = document.createElementNS(NS, 'g');
            group.setAttribute('transform', transform);
            const clone = ref.cloneNode(true);
            group.appendChild(clone);
            svgDom.appendChild(group);
            tempGroups.push(group);
        });

        // Sample one element: get points with CTM applied
        const sampleElement = (el, outPaths) => {
            const tag = el.tagName.toLowerCase();
            const ctm = el.getCTM ? el.getCTM() : null;
            const applyCtm = (pt) => {
                if (!ctm) return { x: pt.x, y: pt.y };
                return {
                    x: pt.x * ctm.a + pt.y * ctm.c + ctm.e,
                    y: pt.x * ctm.b + pt.y * ctm.d + ctm.f
                };
            };

            if (tag === 'path') {
                const d = el.getAttribute('d') || '';
                if (!d.trim()) return;
                const subPathCmds = d.split(/(?=[Mm])/).filter(s => s.trim().length > 0);
                subPathCmds.forEach(subCmd => {
                    const tempPath = document.createElementNS(NS, 'path');
                    tempPath.setAttribute('d', subCmd);
                    const subLen = tempPath.getTotalLength();
                    if (subLen <= 0) return;
                    const points = [];
                    for (let i = 0; i <= subLen; i += precision) {
                        const pt = tempPath.getPointAtLength(Math.min(i, subLen));
                        points.push(applyCtm(pt));
                    }
                    if (points.length > 1) outPaths.push(points);
                });
                return;
            }

            if (['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag)) {
                try {
                    const len = el.getTotalLength();
                    if (len <= 0) return;
                    const points = [];
                    for (let i = 0; i <= len; i += precision) {
                        const pt = el.getPointAtLength(Math.min(i, len));
                        points.push(applyCtm(pt));
                    }
                    if (points.length > 1) outPaths.push(points);
                } catch (err) { /* ignore */ }
            }

            if (tag === 'g' || tag === 'symbol') {
                const children = el.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
                children.forEach(child => sampleElement(child, outPaths));
            }
        };

        // Collect elements to sample: direct shapes not in defs + shapes inside expanded use groups
        const direct = svgDom.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
        direct.forEach(el => {
            if (el.closest('defs')) return;
            sampleElement(el, extractedPaths);
        });

        tempGroups.forEach(g => g.remove());
    hiddenSvgRef.current.innerHTML = '';
    return { paths: extractedPaths, origW, origH };
  };

  const addItemsFromParsed = (name, paths, origW, origH) => {
    if (!paths || paths.length === 0) return;
    const initialWidth = 100;
    const initialHeight = origW > 0 ? round(initialWidth * (origH / origW)) : initialWidth;
    setItems((prev) => {
      const offset = prev.length * 22;
      const newItem = {
        id: createItemId(),
        name,
        paths,
        originalSize: { w: origW, h: origH },
        settings: {
          ...DEFAULT_SETTINGS,
          width: initialWidth,
          height: initialHeight,
          posX: Math.max(-250, -offset),
          posY: Math.min(300 - initialHeight, offset),
        },
      };
      setActiveId(newItem.id);
      return [...prev, newItem];
    });
  };

  // --- Logic: G-Code Generation (all items) ---
  const generateGCode = async () => {
    if (items.length === 0) return;
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 100));

    try {
      const gcode = [];
      const ps = plotterSetup;
      gcode.push(`; Generated by VectorPlotter Studio`);
      gcode.push(`G90`);
      gcode.push(`G21`);
      gcode.push(`G0 Z${ps.zUp} F${ps.travelSpeed}`);
      gcode.push(`G0 X0 Y0 F${ps.travelSpeed}`);

      items.forEach((item) => {
        const { paths: itemPaths, settings: s, originalSize: os } = item;
        if (!itemPaths || itemPaths.length === 0) return;
        const scaleX = s.width / os.w;
        const scaleY = s.height / os.h;
        gcode.push(`; --- ${item.name} ---`);
        itemPaths.forEach((poly) => {
          if (poly.length < 2) return;
          const startX = round((poly[0].x * scaleX) + s.posX);
          const startY = round((poly[0].y * scaleY) + s.posY);
          gcode.push(`G0 X${startX} Y${startY} F${ps.travelSpeed}`);
          gcode.push(`G1 Z${ps.zDown} F${ps.workSpeed}`);
          for (let i = 1; i < poly.length; i++) {
            const x = round((poly[i].x * scaleX) + s.posX);
            const y = round((poly[i].y * scaleY) + s.posY);
            gcode.push(`G1 X${x} Y${y} F${ps.workSpeed}`);
          }
          gcode.push(`G0 Z${ps.zUp} F${ps.travelSpeed}`);
        });
      });

      gcode.push(`G0 X0 Y0 F${ps.travelSpeed}`);
      gcode.push(`M2`);

      const blob = new Blob([gcode.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `plot_${items.length}items.gcode`;
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
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const svgFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.svg'));
    if (svgFiles.length === 0) {
      alert("Please select one or more SVG files.");
      e.target.value = '';
      return;
    }
    svgFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = parseSVG(ev.target.result);
        if (result && result.paths && result.paths.length > 0) {
          const name = file.name.replace(/\.svg$/i, '');
          addItemsFromParsed(name, result.paths, result.origW, result.origH);
        }
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  };

  const updateSetting = (key, value) => {
    if (!activeId) return;
    const numVal = typeof value === 'number' && !Number.isNaN(value) ? round1(value) : value;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== activeId) return it;
        const next = { ...it, settings: { ...it.settings, [key]: numVal } };
        if (it.settings.keepProportions && it.originalSize.w > 0 && (key === 'width' || key === 'height')) {
          const aspect = it.originalSize.w / it.originalSize.h;
          if (key === 'width') next.settings.height = round1(numVal / aspect);
          if (key === 'height') next.settings.width = round1(numVal * aspect);
        }
        return next;
      })
    );
  };

  const deleteItem = (id) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== id);
      if (activeId === id) setActiveId(next.length ? next[0].id : null);
      return next;
    });
  };

  const updatePlotterSetup = (key, value) => {
    const numVal = typeof value === 'number' && !Number.isNaN(value) ? round1(value) : value;
    setPlotterSetup((prev) => ({ ...prev, [key]: numVal }));
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
    const plotItemEl = e.target.closest('[data-plot-item]');
    if (plotItemEl && e.button === 0) {
      e.stopPropagation();
      const id = plotItemEl.dataset.id;
      setActiveId(id);
      dragItemIdRef.current = id;
      setDragMode('IMAGE');
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button === 0) {
      setDragMode('VIEW');
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e) => {
    if (dragMode === 'NONE') return;
    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    if (dragMode === 'VIEW') {
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    } else if (dragMode === 'IMAGE' && dragItemIdRef.current) {
      const dxMm = dx / view.scale;
      const dyMm = -dy / view.scale;
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== dragItemIdRef.current) return it;
          const s = it.settings;
          const minX = -250;
          const maxX = 250 - s.width;
          const minY = 0;
          const maxY = Math.max(0, 300 - s.height);
          return {
            ...it,
            settings: {
              ...s,
              posX: round(Math.max(minX, Math.min(maxX, s.posX + dxMm))),
              posY: round(Math.max(minY, Math.min(maxY, s.posY + dyMm))),
            },
          };
        })
      );
    }
  };

  const handleMouseUp = () => {
    setDragMode('NONE');
  };

  return (
    <div className="roboblock-studio-body">
      <div ref={hiddenSvgRef} style={{ position: 'absolute', width: 0, height: 0, visibility: 'hidden', pointerEvents: 'none' }} />

      <div id="main-container">
        {/* LEFT TOOLBAR (with layers when items exist) */}
        <div className={`plotter-toolbar ${items.length > 0 ? 'plotter-toolbar-with-layers' : ''}`}>
          <label className="plotter-icon-btn" title="Upload SVG (one or more)">
            &#128193;
            <input ref={fileInputRef} type="file" accept=".svg" multiple onChange={handleFile} style={{ display: 'none' }} />
          </label>
          <button className="plotter-icon-btn" title="Reset" onClick={() => { setItems([]); setActiveId(null); setView({ x: 0, y: 0, scale: 2 }); }}>&#10227;</button>
          {items.length > 0 && (
            <>
              <div className="plotter-toolbar-layers-header">Layers</div>
              <div className="plotter-toolbar-layers-list">
                {items.map((it) => (
                  <div
                    key={it.id}
                    onClick={() => setActiveId(it.id)}
                    className={`plotter-toolbar-layer-item ${activeId === it.id ? 'active' : ''}`}
                  >
                    <span className="plotter-toolbar-layer-name" title={it.name}>{it.name}</span>
                    <button type="button" className="plotter-toolbar-layer-delete" onClick={(ev) => { ev.stopPropagation(); deleteItem(it.id); }} title="Remove">×</button>
                  </div>
                ))}
              </div>
            </>
          )}
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

            {items.map((item) => (
              <PlotItem
                key={item.id}
                item={item}
                scale={view.scale}
                isSelected={activeId === item.id}
              />
            ))}

            {items.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '14px', pointerEvents: 'none' }}>
                Load one or more SVGs
              </div>
            )}
          </div>
        </div>

        {/* RIGHT SETTINGS */}
        <div className="plotter-settings">
          {items.length === 0 && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', color: 'var(--text-muted)', backdropFilter: 'blur(4px)' }}>
              Load one or more SVGs to edit
            </div>
          )}

          <div style={{ padding: '20px', overflowY: 'auto', flexGrow: 1 }}>
            <button className="plotter-full-width-btn" onClick={generateGCode} disabled={items.length === 0 || isProcessing}>
              {isProcessing ? 'PROCESSING...' : 'GENERATE G-CODE'}
            </button>

            <div className="plotter-section-header">Plotter setup (all layers)</div>
            <div className="plotter-control-group"><label>Z Up:</label><input type="number" step="0.1" value={plotterSetup.zUp} onChange={(e) => updatePlotterSetup('zUp', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Z Down:</label><input type="number" step="0.1" value={plotterSetup.zDown} onChange={(e) => updatePlotterSetup('zDown', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Work Speed:</label><input type="number" step="0.1" value={plotterSetup.workSpeed} onChange={(e) => updatePlotterSetup('workSpeed', parseFloat(e.target.value) || 0)} /></div>
            <div className="plotter-control-group"><label>Travel Speed:</label><input type="number" step="0.1" value={plotterSetup.travelSpeed} onChange={(e) => updatePlotterSetup('travelSpeed', parseFloat(e.target.value) || 0)} /></div>

            {activeItem && (
              <>
                <div className="plotter-section-header">Dimensions (mm) — {activeItem.name}</div>
                <div className="plotter-control-group"><label>Width:</label><input type="number" step="0.1" value={activeItem.settings.width} onChange={(e) => updateSetting('width', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Height:</label><input type="number" step="0.1" value={activeItem.settings.height} onChange={(e) => updateSetting('height', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Keep proportions:</label><input type="checkbox" checked={activeItem.settings.keepProportions} onChange={(e) => updateSetting('keepProportions', e.target.checked)} /></div>

                <div className="plotter-section-header">Position (mm)</div>
                <div className="plotter-control-group"><label>Pos X:</label><input type="number" step="0.1" value={activeItem.settings.posX} onChange={(e) => updateSetting('posX', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Pos Y:</label><input type="number" step="0.1" value={activeItem.settings.posY} onChange={(e) => updateSetting('posY', parseFloat(e.target.value) || 0)} /></div>
              </>
            )}

            <div className="plotter-hint">
              Upload one or more .SVG files. Paths are traced as lines (vectors).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
