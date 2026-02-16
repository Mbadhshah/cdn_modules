import React, { useState, useEffect, useRef } from 'react';
import './Plotter.css';

// --- Configuration ---
// Bed: origin (0,0) at bottom center
const BED_WIDTH_MM = 500;
const BED_HEIGHT_MM = 300;
const BED_CENTER_X_MM = 250; 

const DEFAULT_SETTINGS = {
  width: 100,
  height: 100,
  keepProportions: true,
  scale: 1, 
  posX: 0,
  posY: 0,
  zUp: 5.0,
  zDown: 0.0,
  workSpeed: 1000,
  travelSpeed: 6000,
};

function createItemId() {
  return 'plot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

// --- Geometry Helpers ---

const round = (num) => Math.round(num * 100) / 100; // Increased precision to 2 decimals

function dist(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Transform a point {x,y} by a matrix DOMMatrix
function transformPoint(pt, matrix) {
  return {
    x: pt.x * matrix.a + pt.y * matrix.c + matrix.e,
    y: pt.x * matrix.b + pt.y * matrix.d + matrix.f
  };
}

// Flatten a Cubic Bezier to simple line segments
function flattenCubicBezier(p1, p2, p3, p4, tolerance = 0.5) {
  // De Casteljau's algorithm or adaptive subdivision could go here.
  // For simplicity and performance, we use fixed steps based on estimated length
  const d1 = dist(p1, p2) + dist(p2, p3) + dist(p3, p4);
  const steps = Math.max(2, Math.ceil(d1 / tolerance));
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const it = 1 - t;
    const x = it*it*it*p1.x + 3*it*it*t*p2.x + 3*it*t*t*p3.x + t*t*t*p4.x;
    const y = it*it*it*p1.y + 3*it*it*t*p2.y + 3*it*t*t*p3.y + t*t*t*p4.y;
    points.push({ x, y });
  }
  return points;
}

// Parse SVG 'd' path string into commands
function tokenizePath(d) {
  const commands = d.match(/([a-df-z])|([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)/gi);
  const tokens = [];
  if (!commands) return tokens;
  let cursor = 0;
  while (cursor < commands.length) {
    const cmd = commands[cursor];
    if (/^[a-df-z]$/i.test(cmd)) {
      tokens.push({ type: 'CMD', val: cmd });
      cursor++;
    } else {
      tokens.push({ type: 'NUM', val: parseFloat(cmd) });
      cursor++;
    }
  }
  return tokens;
}

// --- Component ---

function PlotItem({ item, scale, isSelected }) {
  const canvasRef = useRef(null);
  const { paths, settings, originalSize } = item;
  
  useEffect(() => {
    if (!canvasRef.current || !paths || paths.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Calculate render scale
    const renderScale = 2; // High DPI
    canvas.width = settings.width * renderScale;
    canvas.height = settings.height * renderScale;
    ctx.scale(renderScale, renderScale);
    ctx.clearRect(0, 0, settings.width, settings.height);
    
    // Scale factor (Geometry is already normalized to 0,0 -> width,height by parse logic? 
    // No, geometry is 0,0 -> origW, origH. We scale to settings.width)
    const sx = settings.width / originalSize.w;
    const sy = settings.height / originalSize.h;
    
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1 / Math.max(sx, sy); // keep visual line width constant
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Setup transform for drawing
    ctx.scale(sx, sy);

    paths.forEach(seg => {
      ctx.beginPath();
      if (seg.type === 'line') {
        const pts = seg.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      } else if (seg.type === 'arc') {
        // SVG Arc to Canvas Arc
        // seg has: start, end, rx, ry, rot, largeArc, sweep, center
        // Canvas arc takes center, r, startAngle, endAngle, counterClockwise
        const radius = (seg.rx + seg.ry) / 2; // Visual approximation for ellipses if any
        const startAngle = Math.atan2(seg.start.y - seg.center.y, seg.start.x - seg.center.x);
        const endAngle = Math.atan2(seg.end.y - seg.center.y, seg.end.x - seg.center.x);
        
        ctx.arc(seg.center.x, seg.center.y, radius, startAngle, endAngle, !seg.clockwise);
      }
      ctx.stroke();
    });
  }, [paths, settings, originalSize]);

  return (
    <div
      data-plot-item
      data-id={item.id}
      style={{
        position: 'absolute',
        // Bed logic: Center X is 250.
        left: `${(BED_CENTER_X_MM + settings.posX) * scale}px`,
        // Bed logic: Y=0 is bottom. Top is 300.
        top: `${(BED_HEIGHT_MM - settings.posY - settings.height) * scale}px`,
        width: `${settings.width * scale}px`,
        height: `${settings.height * scale}px`,
        border: isSelected ? '2px dashed var(--accent)' : '1px dashed rgba(255,255,255,0.3)',
        zIndex: isSelected ? 10 : 5,
        cursor: 'move',
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default function VectorPlotter() {
  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1.5 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Interaction refs
  const dragMode = useRef('NONE'); 
  const lastMousePos = useRef({ x: 0, y: 0 });
  const dragItemIdRef = useRef(null);
  
  const fileInputRef = useRef(null);
  const hiddenSvgRef = useRef(null);

  const activeItem = items.find(i => i.id === activeId);

  // --- SVG PARSER ENGINE ---
  
  const parseSVG = (svgText) => {
    // 1. Inject into hidden DOM to use browser's CTM calculations
    if (!hiddenSvgRef.current) return null;
    hiddenSvgRef.current.innerHTML = svgText;
    const svgEl = hiddenSvgRef.current.querySelector('svg');
    if (!svgEl) return null;

    // Handle viewBox / Width / Height
    // We want to determine the "Natural" dimensions to calculate aspect ratio
    const viewBox = svgEl.getAttribute('viewBox');
    let naturalW = parseFloat(svgEl.getAttribute('width'));
    let naturalH = parseFloat(svgEl.getAttribute('height'));
    
    if (viewBox) {
        const vb = viewBox.split(/\s+|,/).filter(Boolean).map(parseFloat);
        if (!naturalW) naturalW = vb[2];
        if (!naturalH) naturalH = vb[3];
    }
    // Defaults if completely missing
    if (!naturalW) naturalW = 100;
    if (!naturalH) naturalH = 100;

    // 2. Expand <use> elements (basic resolution)
    const expandUse = (root) => {
       root.querySelectorAll('use').forEach(useEl => {
          const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
          if(!href) return;
          const id = href.replace('#','');
          const target = svgEl.getElementById(id);
          if(!target) return;
          // Clone and replace
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          // Copy transform
          if(useEl.hasAttribute('transform')) g.setAttribute('transform', useEl.getAttribute('transform'));
          if(useEl.hasAttribute('x') || useEl.hasAttribute('y')) {
             const x = useEl.getAttribute('x') || 0;
             const y = useEl.getAttribute('y') || 0;
             // Append translation to transform
             const existingTr = g.getAttribute('transform') || '';
             g.setAttribute('transform', existingTr + ` translate(${x} ${y})`);
          }
          g.appendChild(target.cloneNode(true));
          useEl.replaceWith(g);
       });
    };
    expandUse(svgEl);

    // 3. Walk and Parse
    const allPaths = [];
    
    // Recursive walker
    const walk = (el, transformStack) => {
      // Get matrix. Note: getCTM returns matrix relative to viewport.
      // We want local accumulated matrix.
      // Easiest is to use getCTM() on the LEAF node, which gives global coord system.
      // But we must be careful about the ViewBox of the root SVG.
      // For simplicity, we trust getCTM() to flatten everything to pixels.
    };

    const extractedSegments = [];
    
    const els = svgEl.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
    els.forEach(el => {
        // Skip defs
        if(el.closest('defs')) return;

        const ctm = el.getCTM(); // Global transform matrix
        const tagName = el.tagName.toLowerCase();
        
        let pathData = '';
        if(tagName === 'path') pathData = el.getAttribute('d');
        else if(tagName === 'rect') {
            const x = parseFloat(el.getAttribute('x'))||0;
            const y = parseFloat(el.getAttribute('y'))||0;
            const w = parseFloat(el.getAttribute('width'))||0;
            const h = parseFloat(el.getAttribute('height'))||0;
            pathData = `M${x},${y} h${w} v${h} h${-w} z`;
        } else if (tagName === 'circle') {
            const cx = parseFloat(el.getAttribute('cx'))||0;
            const cy = parseFloat(el.getAttribute('cy'))||0;
            const r = parseFloat(el.getAttribute('r'))||0;
            // Circle as 2 arcs
            pathData = `M${cx-r},${cy} A${r},${r} 0 1,0 ${cx+r},${cy} A${r},${r} 0 1,0 ${cx-r},${cy}`;
        } else if (tagName === 'ellipse') {
            const cx = parseFloat(el.getAttribute('cx'))||0;
            const cy = parseFloat(el.getAttribute('cy'))||0;
            const rx = parseFloat(el.getAttribute('rx'))||0;
            const ry = parseFloat(el.getAttribute('ry'))||0;
            pathData = `M${cx-rx},${cy} A${rx},${ry} 0 1,0 ${cx+rx},${cy} A${rx},${ry} 0 1,0 ${cx-rx},${cy}`;
        } else if (tagName === 'line') {
             pathData = `M${el.getAttribute('x1')},${el.getAttribute('y1')} L${el.getAttribute('x2')},${el.getAttribute('y2')}`;
        } else if (tagName === 'polygon' || tagName === 'polyline') {
             const pts = el.getAttribute('points');
             if(pts) {
                 const nums = pts.match(/-?[\d.]+/g);
                 if(nums && nums.length >=2) {
                     pathData = `M${nums[0]},${nums[1]} `;
                     for(let i=2; i<nums.length; i+=2) pathData += `L${nums[i]},${nums[i+1]} `;
                     if(tagName === 'polygon') pathData += 'z';
                 }
             }
        }

        if(!pathData) return;

        // Tokenize
        const tokens = tokenizePath(pathData);
        let cursor = 0;
        let currentPt = {x:0, y:0};
        let startSubpath = {x:0, y:0}; // for 'z' command
        
        // Helper to get next number
        const nextNum = () => {
            if(cursor >= tokens.length) return 0;
            if(tokens[cursor].type === 'NUM') return tokens[cursor++].val;
            return 0; 
        };

        let lastCmd = '';

        while(cursor < tokens.length) {
            let cmdItem = tokens[cursor];
            if(cmdItem.type !== 'CMD') {
                 // Implicit command repetition
                 if(lastCmd === 'M') lastCmd = 'L';
                 if(lastCmd === 'm') lastCmd = 'l';
            } else {
                lastCmd = cmdItem.val;
                cursor++;
            }

            const cmdChar = lastCmd.toUpperCase();
            const isRel = lastCmd === lastCmd.toLowerCase();
            
            // Helper for absolute coordinate calculation
            const getCoord = (x, y) => {
                if(isRel) return { x: currentPt.x + x, y: currentPt.y + y };
                return { x, y };
            };

            if(cmdChar === 'M') {
                const pt = getCoord(nextNum(), nextNum());
                currentPt = pt;
                startSubpath = pt;
                // Move doesn't draw, but sets start
            } else if (cmdChar === 'L') {
                const pt = getCoord(nextNum(), nextNum());
                const p1 = transformPoint(currentPt, ctm);
                const p2 = transformPoint(pt, ctm);
                extractedSegments.push({ type: 'line', points: [p1, p2] });
                currentPt = pt;
            } else if (cmdChar === 'H') {
                const val = nextNum();
                const pt = isRel ? { x: currentPt.x + val, y: currentPt.y } : { x: val, y: currentPt.y };
                const p1 = transformPoint(currentPt, ctm);
                const p2 = transformPoint(pt, ctm);
                extractedSegments.push({ type: 'line', points: [p1, p2] });
                currentPt = pt;
            } else if (cmdChar === 'V') {
                const val = nextNum();
                const pt = isRel ? { x: currentPt.x, y: currentPt.y + val } : { x: currentPt.x, y: val };
                const p1 = transformPoint(currentPt, ctm);
                const p2 = transformPoint(pt, ctm);
                extractedSegments.push({ type: 'line', points: [p1, p2] });
                currentPt = pt;
            } else if (cmdChar === 'Z') {
                if(dist(currentPt, startSubpath) > 0.001) {
                    const p1 = transformPoint(currentPt, ctm);
                    const p2 = transformPoint(startSubpath, ctm);
                    extractedSegments.push({ type: 'line', points: [p1, p2] });
                }
                currentPt = startSubpath;
            } else if (cmdChar === 'C') {
                const c1 = getCoord(nextNum(), nextNum());
                const c2 = getCoord(nextNum(), nextNum());
                const end = getCoord(nextNum(), nextNum());
                
                // Flatten Bezier
                const tp1 = transformPoint(currentPt, ctm);
                const tc1 = transformPoint(c1, ctm);
                const tc2 = transformPoint(c2, ctm);
                const tend = transformPoint(end, ctm);
                
                const pts = flattenCubicBezier(tp1, tc1, tc2, tend, 0.5); // 0.5mm tolerance
                if(pts.length > 0) extractedSegments.push({ type: 'line', points: [tp1, ...pts] });
                
                currentPt = end;
            } else if (cmdChar === 'S') {
                 // S mirrors control point 2 of previous C relative to current
                 // Simplified: treat as line for now or implement full S logic if strict needed
                 // For now, doing simple line to end to prevent crashing, but real impl needs last control pt tracking
                 // Improving: fallback to Line
                 const c2 = getCoord(nextNum(), nextNum());
                 const end = getCoord(nextNum(), nextNum());
                 const p1 = transformPoint(currentPt, ctm);
                 const p2 = transformPoint(end, ctm);
                 extractedSegments.push({ type: 'line', points: [p1, p2] });
                 currentPt = end;
            } else if (cmdChar === 'Q' || cmdChar === 'T') {
                 // Quadratic - treat as line for MVP to save space, or flatten
                 const c1 = (cmdChar === 'Q') ? getCoord(nextNum(), nextNum()) : currentPt; // Simplified T
                 const end = getCoord(nextNum(), nextNum());
                 const p1 = transformPoint(currentPt, ctm);
                 const p2 = transformPoint(end, ctm);
                 extractedSegments.push({ type: 'line', points: [p1, p2] });
                 currentPt = end;
            } else if (cmdChar === 'A') {
                const rx = nextNum();
                const ry = nextNum();
                const rot = nextNum();
                const large = nextNum();
                const sweep = nextNum();
                const end = getCoord(nextNum(), nextNum());

                // Transform Endpoints
                const pStart = transformPoint(currentPt, ctm);
                const pEnd = transformPoint(end, ctm);

                // Check for uniform scale
                // Approx scale from matrix
                const scaleX = Math.hypot(ctm.a, ctm.b);
                const scaleY = Math.hypot(ctm.c, ctm.d);
                const isUniform = Math.abs(scaleX - scaleY) < 0.01;

                if (isUniform) {
                    // It remains a circular arc (or scaled circular arc)
                    // We need to calculate Center for G-Code
                    // Math from SVG spec implementation notes
                    // F.6.5 Conversion from endpoint to center parameterization
                    
                    const r = rx * scaleX; // Scaled radius
                    
                    // Simple Arc recovery or G2/G3 output
                    // We'll store it as 'arc' type
                    
                    // First, standard svg arc math to find center
                    // We do this in "Screen Space" (after transform)
                    
                    const x1 = pStart.x; 
                    const y1 = pStart.y;
                    const x2 = pEnd.x; 
                    const y2 = pEnd.y;
                    
                    // Correction: SVG parser usually handles rotation inside matrix, but 'rot' param is local axis rotation
                    // If matrix has rotation, it adds to 'rot'.
                    // Complex. For 'Perfect GCode', usually uniform scale is key.
                    
                    // Let's solve center for the transformed points and scaled Radius
                    // If dist(pStart, pEnd) > 2*r, scale r up
                    const dx = (x1 - x2)/2;
                    const dy = (y1 - y2)/2;
                    const distP = Math.hypot(dx, dy);
                    let currR = r;
                    if(distP > currR) currR = distP; 
                    
                    // Calculate center
                    // This is hard to do perfectly without full implementation
                    // Strategy: If user wants G2/G3, we assume standard cases.
                    // We will emit an ARC segment. The G-Code generator will assume I/J based on this.
                    
                    // We need center for the Canvas preview
                    // For GCode we need Center (I,J)
                    
                    // Let's implement the center conversion helper
                    const phi = rot * Math.PI / 180; // We assume matrix doesn't rotate local axis significantly or it breaks G2/G3 anyway
                    
                    // Standard SVG conversion (simplified for uniform CTM)
                    const x1p = Math.cos(phi)*dx + Math.sin(phi)*dy;
                    const y1p = -Math.sin(phi)*dx + Math.cos(phi)*dy;
                    
                    const sign = (large === sweep) ? -1 : 1;
                    const num = Math.max(0, currR*currR*currR*currR - currR*currR*y1p*y1p - currR*currR*x1p*x1p);
                    const den = currR*currR*y1p*y1p + currR*currR*x1p*x1p;
                    const factor = sign * Math.sqrt(num / (den || 1));
                    
                    const cxp = factor * (currR*y1p/currR);
                    const cyp = factor * (-currR*x1p/currR);
                    
                    const cx = Math.cos(phi)*cxp - Math.sin(phi)*cyp + (x1+x2)/2;
                    const cy = Math.sin(phi)*cxp + Math.cos(phi)*cyp + (y1+y2)/2;
                    
                    extractedSegments.push({
                        type: 'arc',
                        start: pStart,
                        end: pEnd,
                        center: {x: cx, y: cy},
                        rx: currR,
                        ry: currR,
                        clockwise: sweep === 0 
                        // SVG sweep: 1=positive angle (CW in standard screen coords? No, SVG Y is down. 
                        // In SVG: 1 is "positive-angle" direction. 
                        // G-Code: G2 is CW, G3 is CCW.
                        // Standard mapping: Sweep 1 -> G2 (CW) if Y is UP? No.
                        // Let's rely on standard: Sweep 1 -> CW in screen coords (Y down).
                        // GCode machines usually Y up. We flip Y later.
                        // Let's store raw 'sweep'
                    });
                } else {
                     // Non-uniform (Ellipse) -> Flatten to lines
                     // Basic linear interpolation
                     const steps = 10;
                     // ... proper ellipse interpolation is complex code ...
                     // Fallback: simple line
                     extractedSegments.push({ type: 'line', points: [pStart, pEnd] });
                }
                currentPt = end;
            }
        }
    });

    // Clean up
    hiddenSvgRef.current.innerHTML = '';

    // 4. NORMALIZE GEOMETRY (Fix Positioning)
    if(extractedSegments.length === 0) return { paths: [], origW: naturalW, origH: naturalH };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    // Find bounding box of parsed geometry
    const checkPt = (p) => {
        if(p.x < minX) minX = p.x;
        if(p.y < minY) minY = p.y;
        if(p.x > maxX) maxX = p.x;
        if(p.y > maxY) maxY = p.y;
    };

    extractedSegments.forEach(seg => {
        if(seg.type === 'line') seg.points.forEach(checkPt);
        if(seg.type === 'arc') { checkPt(seg.start); checkPt(seg.end); checkPt(seg.center); } // approx
    });

    const geomW = maxX - minX;
    const geomH = maxY - minY;

    // Shift all points so minX, minY becomes 0,0
    const normalizedPaths = extractedSegments.map(seg => {
        if(seg.type === 'line') {
            return {
                type: 'line',
                points: seg.points.map(p => ({ x: p.x - minX, y: p.y - minY }))
            };
        } else if (seg.type === 'arc') {
            return {
                ...seg,
                start: { x: seg.start.x - minX, y: seg.start.y - minY },
                end: { x: seg.end.x - minX, y: seg.end.y - minY },
                center: { x: seg.center.x - minX, y: seg.center.y - minY }
            };
        }
        return seg;
    });

    // Update Dimensions to match tight bounding box
    // This fixes "empty space" issues
    return {
        paths: normalizedPaths,
        origW: geomW > 0 ? geomW : naturalW,
        origH: geomH > 0 ? geomH : naturalH
    };
  };

  // --- Handlers ---

  const handleFile = (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    
    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
        const result = parseSVG(ev.target.result);
        if(result) {
            const name = file.name.replace('.svg','');
            // Add Item
            setItems(prev => {
                const id = createItemId();
                const newItem = {
                    id,
                    name,
                    paths: result.paths,
                    originalSize: { w: result.origW, h: result.origH },
                    settings: {
                        ...DEFAULT_SETTINGS,
                        width: result.origW > 300 ? 100 : result.origW, // auto-scale huge imports
                        height: result.origW > 300 ? (100 * result.origH / result.origW) : result.origH
                    }
                };
                setActiveId(id);
                return [...prev, newItem];
            });
        }
        setIsUploading(false);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const generateGCode = () => {
     if(items.length === 0) return;
     const lines = [];
     lines.push('; Generated by VectorPlotter');
     lines.push('G90 ; Absolute positioning');
     lines.push('G21 ; Units mm');
     lines.push(`G0 Z${items[0].settings.zUp} F${items[0].settings.travelSpeed}`);
     
     items.forEach(item => {
         lines.push(`; Item: ${item.name}`);
         const s = item.settings;
         const scaleX = s.width / item.originalSize.w;
         const scaleY = s.height / item.originalSize.h;
         
         // Helper: User coords (Bottom-Left Origin)
         // Our internal Y is Top-Down (Canvas/SVG style). 
         // Machine Y is Bottom-Up.
         // Also Machine 0,0 is Bottom-Center.
         // PosX/Y are offsets from that 0,0.
         // Item geometry 0,0 is Top-Left of the item.
         
         const toMachine = (pt) => {
             // 1. Scale
             const sx = pt.x * scaleX;
             const sy = pt.y * scaleY;
             
             // 2. Position on Bed (relative to center-bottom)
             // We treat s.posX as offset from Center X
             // We treat s.posY as offset from Bottom Y
             const machineX = BED_CENTER_X_MM + s.posX + sx;
             
             // Y Flip: SVG y grows down. Machine y grows up.
             // We anchor the "Bottom" of the image to s.posY
             // The image height is s.height.
             // In SVG, "Bottom" is max Y. 
             // Logic: MachineY = s.posY + (s.height - sy)
             const machineY = s.posY + (s.height - sy);
             
             return { x: round(machineX), y: round(machineY) };
         };

         item.paths.forEach(seg => {
             // Move to Start
             const start = seg.type === 'line' ? seg.points[0] : seg.start;
             const mStart = toMachine(start);
             
             lines.push(`G0 X${mStart.x} Y${mStart.y}`);
             lines.push(`G1 Z${s.zDown} F${s.workSpeed}`);
             
             if(seg.type === 'line') {
                 for(let i=1; i<seg.points.length; i++) {
                     const p = toMachine(seg.points[i]);
                     lines.push(`G1 X${p.x} Y${p.y}`);
                 }
             } else if (seg.type === 'arc') {
                 const end = toMachine(seg.end);
                 // Center logic for G2/G3 is relative to current point (mStart)
                 // I = CenterX - StartX
                 // J = CenterY - StartY
                 const center = toMachine(seg.center);
                 const I = round(center.x - mStart.x);
                 const J = round(center.y - mStart.y);
                 
                 // Clockwise in SVG (screen Y down) means G2 (CW)?
                 // Let's visualize: 12 -> 3 o'clock. 
                 // Screen: 12=(0,0), 3=(1,0). Arc bends right.
                 // Machine: 12=(0,1), 3=(1,0) (flipped). Arc bends right.
                 // However, we flip Y axis.
                 // Rule: Reflection flips chirality. 
                 // If SVG clockwise = true, and we flip Y, G-Code becomes Counter-Clockwise (G3).
                 const cmd = seg.clockwise ? 'G3' : 'G2'; 
                 
                 lines.push(`${cmd} X${end.x} Y${end.y} I${I} J${J}`);
             }
             lines.push(`G0 Z${s.zUp}`);
         });
     });
     
     lines.push('G0 X0 Y0');
     lines.push('M2');
     
     const blob = new Blob([lines.join('\n')], {type:'text/plain'});
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url;
     a.download = 'plot.gcode';
     a.click();
  };

  // --- UI Interactions ---

  const handleMouseDown = (e) => {
      const el = e.target.closest('[data-plot-item]');
      if(el) {
          e.stopPropagation();
          setActiveId(el.dataset.id);
          dragItemIdRef.current = el.dataset.id;
          dragMode.current = 'ITEM';
      } else {
          dragMode.current = 'VIEW';
      }
      lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e) => {
      if(dragMode.current === 'NONE') return;
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.clientX, y: e.clientY };

      if(dragMode.current === 'VIEW') {
          setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
      } else if (dragMode.current === 'ITEM') {
          // Drag item in MM
          const dxMM = dx / view.scale;
          const dyMM = -dy / view.scale; // Drag up (negative Y pixels) -> Move up (positive Y mm)
          
          setItems(prev => prev.map(item => {
              if(item.id !== dragItemIdRef.current) return item;
              return {
                  ...item,
                  settings: {
                      ...item.settings,
                      posX: round(item.settings.posX + dxMM),
                      posY: round(item.settings.posY + dyMM)
                  }
              };
          }));
      }
  };

  const handleMouseUp = () => dragMode.current = 'NONE';

  const updateSetting = (key, val) => {
      if(!activeItem) return;
      setItems(prev => prev.map(it => {
          if(it.id !== activeId) return it;
          const s = {...it.settings, [key]: val};
          // Ratio lock
          if(it.settings.keepProportions && (key === 'width' || key === 'height')) {
             const ratio = it.originalSize.w / it.originalSize.h;
             if(key === 'width') s.height = round(val / ratio);
             if(key === 'height') s.width = round(val * ratio);
          }
          return { ...it, settings: s };
      }));
  };

  return (
    <div className="roboblock-studio-body">
      {/* Hidden parsing container */}
      <div ref={hiddenSvgRef} style={{position:'absolute', visibility:'hidden', pointerEvents:'none'}} />

      <div id="main-container">
        {/* Toolbar */}
        <div className="plotter-toolbar">
          <label className="plotter-icon-btn" title="Upload SVG">
            &#128193;
            <input ref={fileInputRef} type="file" accept=".svg" onChange={handleFile} style={{display:'none'}} />
          </label>
          <button className="plotter-icon-btn" onClick={() => {setItems([]); setView({x:0, y:0, scale:1.5});}}>&#10227;</button>
        </div>

        {/* Workspace */}
        <div 
          className="plotter-workspace"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={(e) => {
              if(e.ctrlKey || true) {
                  const s = Math.max(0.1, view.scale - Math.sign(e.deltaY)*0.1);
                  setView(v => ({...v, scale: s}));
              }
          }}
          style={{ cursor: dragMode.current==='VIEW'?'grabbing':'default' }}
        >
             <div id="machineBed" style={{
                 width: `${BED_WIDTH_MM * view.scale}px`,
                 height: `${BED_HEIGHT_MM * view.scale}px`,
                 position: 'absolute',
                 left: `calc(50% + ${view.x}px)`,
                 top: `calc(50% + ${view.y}px)`,
                 transform: 'translate(-50%, -50%)',
                 background: '#e0e0e0',
                 backgroundImage: 'linear-gradient(#ccc 1px, transparent 1px), linear-gradient(90deg, #ccc 1px, transparent 1px)',
                 backgroundSize: `${10 * view.scale}px ${10 * view.scale}px`,
                 boxShadow: '0 0 50px rgba(0,0,0,0.5)',
                 borderRadius: 4
             }}>
                 {/* Bed Axis Visuals */}
                 <div style={{position:'absolute', bottom:0, left:'50%', width:2, height:'100%', background:'rgba(255,0,0,0.3)'}} />
                 <div style={{position:'absolute', bottom:0, left:0, width:'100%', height:2, background:'rgba(0,255,0,0.3)'}} />
                 <div style={{position:'absolute', bottom:5, left:'50%', fontSize:10, color:'#555'}}>0,0</div>

                 {items.map(item => (
                     <PlotItem key={item.id} item={item} scale={view.scale} isSelected={activeId === item.id} />
                 ))}
             </div>
        </div>

        {/* Settings */}
        <div className="plotter-settings">
           <div style={{padding:20}}>
               <button className="plotter-full-width-btn" onClick={generateGCode} disabled={items.length===0}>
                   GENERATE G-CODE
               </button>
               
               {activeItem && (
                   <div style={{marginTop:20}}>
                       <div className="plotter-section-header">Size (mm)</div>
                       <div className="plotter-control-group"><label>Width</label> <input type="number" value={activeItem.settings.width} onChange={e=>updateSetting('width', +e.target.value)} /></div>
                       <div className="plotter-control-group"><label>Height</label> <input type="number" value={activeItem.settings.height} onChange={e=>updateSetting('height', +e.target.value)} /></div>
                       
                       <div className="plotter-section-header">Position (mm)</div>
                       <div className="plotter-control-group"><label>X (Center)</label> <input type="number" value={activeItem.settings.posX} onChange={e=>updateSetting('posX', +e.target.value)} /></div>
                       <div className="plotter-control-group"><label>Y (Bottom)</label> <input type="number" value={activeItem.settings.posY} onChange={e=>updateSetting('posY', +e.target.value)} /></div>

                       <div className="plotter-section-header">Speeds</div>
                       <div className="plotter-control-group"><label>Work (F)</label> <input type="number" value={activeItem.settings.workSpeed} onChange={e=>updateSetting('workSpeed', +e.target.value)} /></div>
                       <div className="plotter-control-group"><label>Travel (F)</label> <input type="number" value={activeItem.settings.travelSpeed} onChange={e=>updateSetting('travelSpeed', +e.target.value)} /></div>
                   </div>
               )}
               
               {!activeItem && items.length > 0 && (
                   <div className="plotter-hint">Select an item on the bed to edit settings.</div>
               )}
               {items.length === 0 && !isUploading && (
                   <div className="plotter-hint">Upload an SVG to begin.</div>
               )}
           </div>
        </div>
      </div>
    </div>
  );
}
