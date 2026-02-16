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

// SVG arc (endpoint param) -> center param. Returns { cx, cy, clockwise } for circular arc, or null if line/degenerate.
// phi in degrees; fA = large-arc, fS = sweep (0=CW, 1=CCW). For G-code: G2=CW, G3=CCW.
function svgArcToCenter(x1, y1, x2, y2, rx, ry, phiDeg, fA, fS) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9) return null;
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sq = (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p);
  if (sq < 0) return null;
  const coef = (fA !== fS ? 1 : -1) * Math.sqrt(Math.max(0, sq));
  const cxp = coef * (rx * y1p / ry);
  const cyp = coef * (-ry * x1p / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const clockwise = fS === 0;
  return { cx, cy, clockwise, rx, ry };
}

// Path segment: either { type: 'line', points: [{x,y},...] } or { type: 'arc', start, end, center, clockwise }.
// Normalize so backward compat: if a path item is a plain array of points, treat as { type: 'line', points }.
function toSegment(poly) {
  if (!poly || !Array.isArray(poly)) return null;
  if (poly.type === 'arc') return poly;
  if (poly.type === 'line' && poly.points) return poly;
  return { type: 'line', points: poly };
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
      const seg = toSegment(poly);
      if (!seg) return;
      ctx.beginPath();
      if (seg.type === 'arc') {
        const sx = seg.start.x * scaleFactorX, sy = seg.start.y * scaleFactorY;
        const cx = seg.center.x * scaleFactorX, cy = seg.center.y * scaleFactorY;
        const ex = seg.end.x * scaleFactorX, ey = seg.end.y * scaleFactorY;
        const r = Math.hypot(sx - cx, sy - cy);
        const startAngle = Math.atan2(sy - cy, sx - cx);
        const endAngle = Math.atan2(ey - cy, ex - cx);
        ctx.arc(cx, cy, r, startAngle, endAngle, seg.clockwise);
      } else {
        const pts = seg.points;
        if (!pts || pts.length < 2) return;
        ctx.moveTo(pts[0].x * scaleFactorX, pts[0].y * scaleFactorY);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * scaleFactorX, pts[i].y * scaleFactorY);
      }
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
  
  // View State: x/y for panning the bed, scale for zoom
  const [view, setView] = useState({ x: 0, y: 0, scale: 2.0 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // --- Interaction State ---
  const [dragMode, setDragMode] = useState('NONE'); // 'NONE', 'VIEW', 'IMAGE'
  const lastMousePos = useRef({ x: 0, y: 0 });
  const dragItemIdRef = useRef(null);
  const pendingUploadsRef = useRef(0);

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

        // Recursively expand <use> inside a cloned element so nested symbols appear (depth limit to avoid cycles)
        const expandUsesInClone = (clone, svgRoot, depth) => {
            if (depth > 15) return;
            const uses = clone.querySelectorAll ? Array.from(clone.querySelectorAll('use')) : [];
            uses.forEach((useEl) => {
                const id = getRefId(useEl);
                if (!id) return;
                const ref = svgRoot.querySelector('[id="' + id + '"]') || document.getElementById(id);
                if (!ref) return;
                const tag = ref.tagName.toLowerCase();
                const supported = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'symbol'];
                if (!supported.includes(tag)) return;
                const useX = parseFloat(useEl.getAttribute('x')) || 0;
                const useY = parseFloat(useEl.getAttribute('y')) || 0;
                let transform = `translate(${useX},${useY})`;
                const tr = useEl.getAttribute('transform');
                if (tr) transform = tr + ' ' + transform;
                const innerGroup = document.createElementNS(NS, 'g');
                innerGroup.setAttribute('transform', transform);
                const innerClone = ref.cloneNode(true);
                expandUsesInClone(innerClone, svgRoot, depth + 1);
                innerGroup.appendChild(innerClone);
                if (useEl.parentNode) useEl.parentNode.replaceChild(innerGroup, useEl);
            });
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
            expandUsesInClone(clone, svgDom, 0);
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
                    if (points.length > 1) outPaths.push({ type: 'line', points });
                });
                return;
            }

            if (tag === 'circle') {
                const cx = parseFloat(el.getAttribute('cx')) || 0;
                const cy = parseFloat(el.getAttribute('cy')) || 0;
                const r = parseFloat(el.getAttribute('r')) || 0;
                if (r <= 0) return;
                const start1 = applyCtm({ x: cx + r, y: cy });
                const end1 = applyCtm({ x: cx - r, y: cy });
                const center = applyCtm({ x: cx, y: cy });
                outPaths.push({ type: 'arc', start: start1, end: end1, center, clockwise: false });
                outPaths.push({ type: 'arc', start: end1, end: start1, center, clockwise: true });
                return;
            }

            if (tag === 'ellipse') {
                const cx = parseFloat(el.getAttribute('cx')) || 0;
                const cy = parseFloat(el.getAttribute('cy')) || 0;
                let rx = parseFloat(el.getAttribute('rx')) || 0;
                let ry = parseFloat(el.getAttribute('ry')) || 0;
                if (rx <= 0 || ry <= 0) return;
                if (Math.abs(rx - ry) < 1e-6) {
                    const start1 = applyCtm({ x: cx + rx, y: cy });
                    const end1 = applyCtm({ x: cx - rx, y: cy });
                    const center = applyCtm({ x: cx, y: cy });
                    outPaths.push({ type: 'arc', start: start1, end: end1, center, clockwise: false });
                    outPaths.push({ type: 'arc', start: end1, end: start1, center, clockwise: true });
                } else {
                    try {
                        const len = el.getTotalLength();
                        if (len <= 0) return;
                        const points = [];
                        for (let i = 0; i <= len; i += precision) {
                            const pt = el.getPointAtLength(Math.min(i, len));
                            points.push(applyCtm(pt));
                        }
                        if (points.length > 1) outPaths.push({ type: 'line', points });
                    } catch (err) { /* ignore */ }
                }
                return;
            }

            if (['rect', 'line', 'polyline', 'polygon'].includes(tag)) {
                try {
                    const len = el.getTotalLength();
                    if (len <= 0) return;
                    const points = [];
                    for (let i = 0; i <= len; i += precision) {
                        const pt = el.getPointAtLength(Math.min(i, len));
                        points.push(applyCtm(pt));
                    }
                    if (points.length > 1) outPaths.push({ type: 'line', points });
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
      const first = items[0].settings;
      gcode.push(`; Generated by VectorPlotter Studio`);
      gcode.push(`G90`);
      gcode.push(`G21`);
      gcode.push(`G0 Z${first.zUp} F${first.travelSpeed}`);
      gcode.push(`G0 X0 Y0 F${first.travelSpeed}`);

      items.forEach((item) => {
        const { paths: itemPaths, settings: s, originalSize: os } = item;
        if (!itemPaths || itemPaths.length === 0) return;
        const scaleX = s.width / os.w;
        const scaleY = s.height / os.h;
        gcode.push(`; --- ${item.name} ---`);
        itemPaths.forEach((poly) => {
          const seg = toSegment(poly);
          if (!seg) return;
          if (seg.type === 'arc') {
            const startX = round((seg.start.x * scaleX) + s.posX);
            const startY = round((seg.start.y * scaleY) + s.posY);
            const endX = round((seg.end.x * scaleX) + s.posX);
            const endY = round((seg.end.y * scaleY) + s.posY);
            const centerX = (seg.center.x * scaleX) + s.posX;
            const centerY = (seg.center.y * scaleY) + s.posY;
            const I = round(centerX - (seg.start.x * scaleX + s.posX));
            const J = round(centerY - (seg.start.y * scaleY + s.posY));
            gcode.push(`G0 X${startX} Y${startY} F${s.travelSpeed}`);
            gcode.push(`G1 Z${s.zDown} F${s.workSpeed}`);
            gcode.push((seg.clockwise ? `G2` : `G3`) + ` X${endX} Y${endY} I${I} J${J} F${s.workSpeed}`);
            gcode.push(`G0 Z${s.zUp} F${s.travelSpeed}`);
          } else {
            const pts = seg.points;
            if (!pts || pts.length < 2) return;
            const startX = round((pts[0].x * scaleX) + s.posX);
            const startY = round((pts[0].y * scaleY) + s.posY);
            gcode.push(`G0 X${startX} Y${startY} F${s.travelSpeed}`);
            gcode.push(`G1 Z${s.zDown} F${s.workSpeed}`);
            for (let i = 1; i < pts.length; i++) {
              const x = round((pts[i].x * scaleX) + s.posX);
              const y = round((pts[i].y * scaleY) + s.posY);
              gcode.push(`G1 X${x} Y${y} F${s.workSpeed}`);
            }
            gcode.push(`G0 Z${s.zUp} F${s.travelSpeed}`);
          }
        });
      });

      gcode.push(`G0 X0 Y0 F${first.travelSpeed}`);
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
      alert("Please select image files (SVG).");
      e.target.value = '';
      return;
    }
    pendingUploadsRef.current = svgFiles.length;
    setIsUploading(true);
    svgFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = parseSVG(ev.target.result);
        if (result && result.paths && result.paths.length > 0) {
          const name = file.name.replace(/\.svg$/i, '');
          addItemsFromParsed(name, result.paths, result.origW, result.origH);
        }
        pendingUploadsRef.current -= 1;
        if (pendingUploadsRef.current === 0) setIsUploading(false);
      };
      reader.onerror = () => {
        pendingUploadsRef.current -= 1;
        if (pendingUploadsRef.current === 0) setIsUploading(false);
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
        {/* LEFT TOOLBAR */}
        <div className="plotter-toolbar">
          <label className="plotter-icon-btn" title="Upload images">
            &#128193;
            <input ref={fileInputRef} type="file" accept=".svg" multiple onChange={handleFile} style={{ display: 'none' }} />
          </label>
          <button className="plotter-icon-btn" title="Reset" onClick={() => { setItems([]); setActiveId(null); setView({ x: 0, y: 0, scale: 2 }); }}>&#10227;</button>
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

            {isUploading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', color: 'var(--accent)', fontSize: '16px', fontWeight: 'bold', pointerEvents: 'none', zIndex: 50 }}>
                Uploading…
              </div>
            )}
            {items.length === 0 && !isUploading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '14px', pointerEvents: 'none' }}>
                Load images
              </div>
            )}
          </div>
        </div>

        {/* RIGHT SETTINGS */}
        <div className="plotter-settings">
          {items.length === 0 && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', color: 'var(--text-muted)', backdropFilter: 'blur(4px)' }}>
              Load images
            </div>
          )}

          <div style={{ padding: '20px', overflowY: 'auto', flexGrow: 1 }}>
            <button className="plotter-full-width-btn" onClick={generateGCode} disabled={items.length === 0 || isProcessing} style={{ marginBottom: 16 }}>
              {isProcessing ? 'PROCESSING...' : 'GENERATE G-CODE'}
            </button>

            {items.length > 0 && (
              <div style={{ marginTop: 12, marginBottom: 8, maxHeight: 120, overflowY: 'auto' }}>
                {items.map((it) => (
                  <div
                    key={it.id}
                    onClick={() => setActiveId(it.id)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 8px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
                      background: activeId === it.id ? 'rgba(0,210,255,0.2)' : 'rgba(255,255,255,0.05)',
                      border: activeId === it.id ? '1px solid var(--accent)' : '1px solid transparent',
                    }}
                  >
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{it.name}</span>
                    <button type="button" onClick={(ev) => { ev.stopPropagation(); deleteItem(it.id); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 4px', fontSize: 14 }} title="Remove">×</button>
                  </div>
                ))}
              </div>
            )}

            {activeItem && (
              <>
                <div className="plotter-section-header">Dimensions (mm)</div>
                <div className="plotter-control-group"><label>Width:</label><input type="number" step="0.1" value={activeItem.settings.width} onChange={(e) => updateSetting('width', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Height:</label><input type="number" step="0.1" value={activeItem.settings.height} onChange={(e) => updateSetting('height', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Keep proportions:</label><input type="checkbox" checked={activeItem.settings.keepProportions} onChange={(e) => updateSetting('keepProportions', e.target.checked)} /></div>

                <div className="plotter-section-header">Position (mm)</div>
                <div className="plotter-control-group"><label>Pos X:</label><input type="number" step="0.1" value={activeItem.settings.posX} onChange={(e) => updateSetting('posX', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Pos Y:</label><input type="number" step="0.1" value={activeItem.settings.posY} onChange={(e) => updateSetting('posY', parseFloat(e.target.value) || 0)} /></div>

                <div className="plotter-section-header">Plotter setup</div>
                <div className="plotter-control-group"><label>Z Up:</label><input type="number" step="0.1" value={activeItem.settings.zUp} onChange={(e) => updateSetting('zUp', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Z Down:</label><input type="number" step="0.1" value={activeItem.settings.zDown} onChange={(e) => updateSetting('zDown', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Work Speed:</label><input type="number" step="0.1" value={activeItem.settings.workSpeed} onChange={(e) => updateSetting('workSpeed', parseFloat(e.target.value) || 0)} /></div>
                <div className="plotter-control-group"><label>Travel Speed:</label><input type="number" step="0.1" value={activeItem.settings.travelSpeed} onChange={(e) => updateSetting('travelSpeed', parseFloat(e.target.value) || 0)} /></div>
              </>
            )}

            <div className="plotter-hint">
              Load images (.SVG). Paths are traced as lines (vectors).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
