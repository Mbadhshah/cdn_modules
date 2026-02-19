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

// Adaptive Bezier subdivision tolerance (path units; ~0.05mm for smooth curves)
const BEZIER_FLATNESS_TOLERANCE = 0.05;

// Option B: Detect when 4 cubic Bezier segments form a circle. Returns { cx, cy, r, clockwise } or null.
function fitCircleFrom4Points(A, B, C, D) {
  const tol = 0.05; // 5% radius tolerance (design tools often approximate circles)
  const angleTol = (25 * Math.PI) / 180; // ~25° for 90° spacing
  const midAB = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const midBC = { x: (B.x + C.x) / 2, y: (B.y + C.y) / 2 };
  const perpAB = { x: A.y - B.y, y: B.x - A.x };
  const perpBC = { x: B.y - C.y, y: C.x - B.x };
  const dmx = midBC.x - midAB.x;
  const dmy = midBC.y - midAB.y;
  const denom = perpAB.x * perpBC.y - perpAB.y * perpBC.x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = (dmx * perpBC.y - dmy * perpBC.x) / denom;
  const cx = midAB.x + t * perpAB.x;
  const cy = midAB.y + t * perpAB.y;
  const r = Math.hypot(A.x - cx, A.y - cy);
  if (r < 1e-9) return null;
  const rB = Math.hypot(B.x - cx, B.y - cy);
  const rC = Math.hypot(C.x - cx, C.y - cy);
  const rD = Math.hypot(D.x - cx, D.y - cy);
  if (Math.abs(rB - r) / r > tol || Math.abs(rC - r) / r > tol || Math.abs(rD - r) / r > tol) return null;
  const angle = (px, py) => Math.atan2(py - cy, px - cx);
  const a0 = angle(A.x, A.y);
  const a1 = angle(B.x, B.y);
  const a2 = angle(C.x, C.y);
  const a3 = angle(D.x, D.y);
  const angles = [a0, a1, a2, a3].sort((u, v) => u - v);
  for (let i = 0; i < 4; i++) {
    const diff = i < 3 ? angles[i + 1] - angles[i] : 2 * Math.PI - (angles[3] - angles[0]);
    if (Math.abs(diff - Math.PI / 2) > angleTol) return null;
  }
  const cross = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x);
  const clockwise = cross > 0;
  return { cx, cy, r, clockwise };
}

// Cubic Bezier at t: P0,P1,P2,P3
function cubicAt(t, P0, P1, P2, P3) {
  const u = 1 - t;
  const u2 = u * u, u3 = u2 * u;
  const t2 = t * t, t3 = t2 * t;
  return {
    x: u3 * P0.x + 3 * u2 * t * P1.x + 3 * u * t2 * P2.x + t3 * P3.x,
    y: u3 * P0.y + 3 * u2 * t * P1.y + 3 * u * t2 * P2.y + t3 * P3.y,
  };
}

// Quadratic Bezier at t: P0,P1,P2
function quadAt(t, P0, P1, P2) {
  const u = 1 - t;
  const u2 = u * u;
  const t2 = t * t;
  return {
    x: u2 * P0.x + 2 * u * t * P1.x + t2 * P2.x,
    y: u2 * P0.y + 2 * u * t * P1.y + t2 * P2.y,
  };
}

// Distance from point to line segment (P0-P1)
function pointToLineDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1e-10;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (len * len)));
  const projX = x0 + t * dx, projY = y0 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

// Recursive subdivision: cubic Bezier (de Casteljau at t=0.5) until flatness < tolerance.
function adaptiveCubic(P0, P1, P2, P3, tolerance, out) {
  const d1 = pointToLineDist(P1.x, P1.y, P0.x, P0.y, P3.x, P3.y);
  const d2 = pointToLineDist(P2.x, P2.y, P0.x, P0.y, P3.x, P3.y);
  if (d1 <= tolerance && d2 <= tolerance) {
    out.push(P3);
    return;
  }
  const L1 = { x: (P0.x + P1.x) / 2, y: (P0.y + P1.y) / 2 };
  const H = { x: (P1.x + P2.x) / 2, y: (P1.y + P2.y) / 2 };
  const R2 = { x: (P2.x + P3.x) / 2, y: (P2.y + P3.y) / 2 };
  const L2 = { x: (L1.x + H.x) / 2, y: (L1.y + H.y) / 2 };
  const R1 = { x: (H.x + R2.x) / 2, y: (H.y + R2.y) / 2 };
  const M = { x: (L2.x + R1.x) / 2, y: (L2.y + R1.y) / 2 };
  adaptiveCubic(P0, L1, L2, M, tolerance, out);
  adaptiveCubic(M, R1, R2, P3, tolerance, out);
}

// Recursive subdivision: quadratic Bezier until flatness < tolerance.
function adaptiveQuad(P0, P1, P2, tolerance, out) {
  const d = pointToLineDist(P1.x, P1.y, P0.x, P0.y, P2.x, P2.y);
  if (d <= tolerance) {
    out.push(P2);
    return;
  }
  const M = quadAt(0.5, P0, P1, P2);
  const L1 = { x: (P0.x + P1.x) / 2, y: (P0.y + P1.y) / 2 };
  const R1 = { x: (P1.x + P2.x) / 2, y: (P1.y + P2.y) / 2 };
  const L2 = { x: (L1.x + R1.x) / 2, y: (L1.y + R1.y) / 2 };
  adaptiveQuad(P0, L1, L2, tolerance, out);
  adaptiveQuad(L2, R1, P2, tolerance, out);
}

// --- GCode (ggcode-style) arc fitting helpers ---
function distPt(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}
function pointAtCubic(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}
function fitCircle3Points(a, b, c) {
  const midAB = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dyAB = b.y - a.y;
  const dxAB = b.x - a.x;
  const midBC = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const dyBC = c.y - b.y;
  const dxBC = c.x - b.x;
  const det = dxAB * dyBC - dyAB * dxBC;
  if (Math.abs(det) < 1e-6) return null;
  const C1 = midAB.x * dxAB + midAB.y * dyAB;
  const C2 = midBC.x * dxBC + midBC.y * dyBC;
  const cx = (C1 * dyBC - C2 * dyAB) / det;
  const cy = (dxAB * C2 - dxBC * C1) / det;
  const center = { x: cx, y: cy };
  const r = distPt(center, a);
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return { center, r, cw: cross < 0 };
}
function splitCubic(p0, p1, p2, p3, t) {
  const lerp = (a, b, s) => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s });
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return { left: [p0, p01, p012, p0123], right: [p0123, p123, p23, p3] };
}
// SVG endpoint arc to center (circular arc: rx=ry, rot unused for center).
function findCenterArc(x1, y1, x2, y2, r, large, sweep) {
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = dx2;
  const y1p = dy2;
  const denom = r * r * x1p * x1p + r * r * y1p * y1p;
  if (denom < 1e-12) return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  let val = (r * r * r * r - r * r * x1p * x1p - r * r * y1p * y1p) / denom;
  val = Math.max(0, val);
  let coef = Math.sqrt(val);
  if (large === sweep) coef = -coef;
  const cxp = coef * (r * y1p / r);
  const cyp = coef * (-(r * x1p) / r);
  return { x: cxp + (x1 + x2) / 2, y: cyp + (y1 + y2) / 2 };
}
function fitArcsToCubic(p0, p1, p2, p3, tolerance, depth) {
  if (depth > 6) return [{ type: 'line', start: p0, end: p3 }];
  const mid = pointAtCubic(0.5, p0, p1, p2, p3);
  const arc = fitCircle3Points(p0, mid, p3);
  let maxErr = Infinity;
  if (arc && arc.r < 10000) {
    const pt1 = pointAtCubic(0.25, p0, p1, p2, p3);
    const pt2 = pointAtCubic(0.75, p0, p1, p2, p3);
    maxErr = Math.max(
      Math.abs(distPt(pt1, arc.center) - arc.r),
      Math.abs(distPt(pt2, arc.center) - arc.r)
    );
  } else if (!arc) {
    return [{ type: 'line', start: p0, end: p3 }];
  }
  if (maxErr < tolerance && arc) {
    return [{ type: 'arc', start: p0, end: p3, center: arc.center, cw: arc.cw }];
  }
  const split = splitCubic(p0, p1, p2, p3, 0.5);
  return [
    ...fitArcsToCubic(split.left[0], split.left[1], split.left[2], split.left[3], tolerance, depth + 1),
    ...fitArcsToCubic(split.right[0], split.right[1], split.right[2], split.right[3], tolerance, depth + 1),
  ];
}

// GGcode-style: explode path "d" into segments { type: 'arc'|'line'|'curve', d?, p1, p2, params }. applyCtm transforms points.
function explodePathToSegments(d, applyCtm) {
  const out = [];
  const pt = (x, y) => applyCtm({ x, y });
  const commandPattern = /([a-zA-Z])([^a-zA-Z]*)/g;
  let match;
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastControlX = 0;
  let lastControlY = 0;
  let lastCmdWasCurve = false;
  const updateCurrent = (x, y) => {
    currentX = x;
    currentY = y;
  };
  while ((match = commandPattern.exec(d)) !== null) {
    const command = match[1];
    const args = match[2].trim().match(/-?[\d.]+(?:e-?\d+)?/g)?.map(parseFloat) || [];
    const lowerCmd = command.toLowerCase();
    const isRelative = command === lowerCmd;
    let isCurveBlock = false;
    switch (lowerCmd) {
      case 'm':
        if (args.length >= 2) {
          currentX = isRelative ? currentX + args[0] : args[0];
          currentY = isRelative ? currentY + args[1] : args[1];
          startX = currentX;
          startY = currentY;
          for (let i = 2; i < args.length; i += 2) {
            const nx = isRelative ? currentX + args[i] : args[i];
            const ny = isRelative ? currentY + args[i + 1] : args[i + 1];
            out.push({ type: 'line', d: `M${currentX},${currentY} L${nx},${ny}`, p1: pt(currentX, currentY), p2: pt(nx, ny), params: {} });
            updateCurrent(nx, ny);
          }
        }
        break;
      case 'l':
        for (let i = 0; i < args.length; i += 2) {
          const nx = isRelative ? currentX + args[i] : args[i];
          const ny = isRelative ? currentY + args[i + 1] : args[i + 1];
          out.push({ type: 'line', d: `M${currentX},${currentY} L${nx},${ny}`, p1: pt(currentX, currentY), p2: pt(nx, ny), params: {} });
          updateCurrent(nx, ny);
        }
        break;
      case 'h':
        for (let i = 0; i < args.length; i++) {
          const nx = isRelative ? currentX + args[i] : args[i];
          out.push({ type: 'line', d: `M${currentX},${currentY} L${nx},${currentY}`, p1: pt(currentX, currentY), p2: pt(nx, currentY), params: {} });
          updateCurrent(nx, currentY);
        }
        break;
      case 'v':
        for (let i = 0; i < args.length; i++) {
          const ny = isRelative ? currentY + args[i] : args[i];
          out.push({ type: 'line', d: `M${currentX},${currentY} L${currentX},${ny}`, p1: pt(currentX, currentY), p2: pt(currentX, ny), params: {} });
          updateCurrent(currentX, ny);
        }
        break;
      case 'z':
        if (currentX !== startX || currentY !== startY) {
          out.push({ type: 'line', d: `M${currentX},${currentY} L${startX},${startY}`, p1: pt(currentX, currentY), p2: pt(startX, startY), params: {} });
        }
        updateCurrent(startX, startY);
        break;
      case 'c':
      case 's': {
        let i = 0;
        while (i < args.length) {
          let x1, y1, x2, y2, x, y;
          if (lowerCmd === 'c') {
            x1 = isRelative ? currentX + args[i] : args[i];
            y1 = isRelative ? currentY + args[i + 1] : args[i + 1];
            x2 = isRelative ? currentX + args[i + 2] : args[i + 2];
            y2 = isRelative ? currentY + args[i + 3] : args[i + 3];
            x = isRelative ? currentX + args[i + 4] : args[i + 4];
            y = isRelative ? currentY + args[i + 5] : args[i + 5];
            i += 6;
          } else {
            x1 = lastCmdWasCurve ? 2 * currentX - lastControlX : currentX;
            y1 = lastCmdWasCurve ? 2 * currentY - lastControlY : currentY;
            x2 = isRelative ? currentX + args[i] : args[i];
            y2 = isRelative ? currentY + args[i + 1] : args[i + 1];
            x = isRelative ? currentX + args[i + 2] : args[i + 2];
            y = isRelative ? currentY + args[i + 3] : args[i + 3];
            i += 4;
          }
          const start = pt(currentX, currentY);
          const end = pt(x, y);
          out.push({
            type: 'curve',
            d: `M${currentX},${currentY} C${x1},${y1} ${x2},${y2} ${x},${y}`,
            p1: start,
            p2: end,
            params: { type: 'cubic', x1, y1, x2, y2, x, y },
          });
          lastControlX = x2;
          lastControlY = y2;
          lastCmdWasCurve = true;
          isCurveBlock = true;
          updateCurrent(x, y);
        }
        break;
      }
      case 'q':
      case 't': {
        let j = 0;
        while (j < args.length) {
          let x1, y1, x, y;
          if (lowerCmd === 'q') {
            x1 = isRelative ? currentX + args[j] : args[j];
            y1 = isRelative ? currentY + args[j + 1] : args[j + 1];
            x = isRelative ? currentX + args[j + 2] : args[j + 2];
            y = isRelative ? currentY + args[j + 3] : args[j + 3];
            j += 4;
          } else {
            x1 = lastCmdWasCurve ? 2 * currentX - lastControlX : currentX;
            y1 = lastCmdWasCurve ? 2 * currentY - lastControlY : currentY;
            x = isRelative ? currentX + args[j] : args[j];
            y = isRelative ? currentY + args[j + 1] : args[j + 1];
            j += 2;
          }
          out.push({
            type: 'curve',
            d: `M${currentX},${currentY} Q${x1},${y1} ${x},${y}`,
            p1: pt(currentX, currentY),
            p2: pt(x, y),
            params: { type: 'quadratic', x1, y1, x, y },
          });
          lastControlX = x1;
          lastControlY = y1;
          lastCmdWasCurve = true;
          isCurveBlock = true;
          updateCurrent(x, y);
        }
        break;
      }
      case 'a':
        for (let k = 0; k < args.length; k += 7) {
          const rx = args[k];
          const ry = args[k + 1];
          const rot = args[k + 2];
          const large = args[k + 3];
          const sweep = args[k + 4];
          const x = isRelative ? currentX + args[k + 5] : args[k + 5];
          const y = isRelative ? currentY + args[k + 6] : args[k + 6];
          out.push({
            type: 'arc',
            d: `M${currentX},${currentY} A${rx} ${ry} ${rot} ${large} ${sweep} ${x} ${y}`,
            p1: pt(currentX, currentY),
            p2: pt(x, y),
            params: { rx, ry, rot, large, sweep },
          });
          updateCurrent(x, y);
        }
        break;
      default:
        break;
    }
    if (!isCurveBlock) lastCmdWasCurve = false;
  }
  return out;
}

// GGcode-style G-code generator: connectivity-aware, arc fitting for curves. Segments: { type, p1, p2, params?, d? }.
function ggcodeGenerateGCode(segments, scale, workFeed, travelFeed, safeZ, cutZ, isLaser) {
  const code = [];
  code.push('; Generated by VectorPlotter Studio (ggcode-style)');
  code.push('G90');
  code.push('G21');
  code.push('G17');
  if (!isLaser) {
    code.push(`G0 Z${safeZ} F${travelFeed}`);
  } else {
    code.push('M5');
  }
  let lastX = null;
  let lastY = null;
  let isCutting = false;
  const fmt = (n) => (typeof n === 'number' ? (n * scale).toFixed(3) : String(n));
  const ARC_TOLERANCE = Math.max(0.05, 0.1 / scale);
  const DISCONTINUOUS_MM = 0.05;

  segments.forEach((seg) => {
    const startX = seg.p1.x;
    const startY = seg.p1.y;
    const endX = seg.p2.x;
    const endY = seg.p2.y;
    const distToStart = lastX == null ? Infinity : Math.hypot(startX - lastX, startY - lastY);
    const isDiscontinuous = distToStart > DISCONTINUOUS_MM;

    if (isDiscontinuous) {
      if (isCutting) {
        if (isLaser) code.push('M5');
        else code.push(`G0 Z${safeZ} F${travelFeed}`);
        isCutting = false;
      }
      code.push(`G0 X${fmt(startX)} Y${fmt(startY)} F${travelFeed}`);
      if (isLaser) code.push('M3 S1000');
      else code.push(`G1 Z${cutZ} F${workFeed}`);
      isCutting = true;
    } else if (!isCutting) {
      if (isLaser) code.push('M3 S1000');
      else code.push(`G1 Z${cutZ} F${workFeed}`);
      isCutting = true;
    }

    if (seg.type === 'line') {
      code.push(`G1 X${fmt(endX)} Y${fmt(endY)} F${workFeed}`);
      lastX = endX;
      lastY = endY;
    } else if (seg.type === 'arc') {
      const { rx, ry, large, sweep } = seg.params || {};
      if (typeof rx !== 'number' || Math.abs(rx - ry) > 0.001) {
        const tempPath = typeof document !== 'undefined' && document.createElementNS
          ? document.createElementNS('http://www.w3.org/2000/svg', 'path')
          : null;
        if (tempPath && seg.d) {
          tempPath.setAttribute('d', seg.d);
          const len = tempPath.getTotalLength();
          const steps = Math.max(8, Math.ceil(len / 0.5));
          for (let i = 1; i <= steps; i++) {
            const p = tempPath.getPointAtLength((i / steps) * len);
            code.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} F${workFeed}`);
          }
        } else {
          code.push(`G1 X${fmt(endX)} Y${fmt(endY)} F${workFeed}`);
        }
        lastX = endX;
        lastY = endY;
      } else {
        const center = findCenterArc(startX, startY, endX, endY, rx, large, sweep);
        const I = center.x - startX;
        const J = center.y - startY;
        const cmd = sweep === 1 ? 'G2' : 'G3';
        code.push(`${cmd} X${fmt(endX)} Y${fmt(endY)} I${fmt(I)} J${fmt(J)} F${workFeed}`);
        lastX = endX;
        lastY = endY;
      }
    } else if (seg.type === 'curve') {
      let points;
      if (seg.params?.type === 'quadratic') {
        const p0 = { x: startX, y: startY };
        const p1 = { x: seg.params.x1, y: seg.params.y1 };
        const p2 = { x: endX, y: endY };
        const cp1 = { x: p0.x + (2 / 3) * (p1.x - p0.x), y: p0.y + (2 / 3) * (p1.y - p0.y) };
        const cp2 = { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) };
        points = [p0, cp1, cp2, p2];
      } else {
        points = [
          { x: startX, y: startY },
          { x: seg.params.x1, y: seg.params.y1 },
          { x: seg.params.x2, y: seg.params.y2 },
          { x: endX, y: endY },
        ];
      }
      const results = fitArcsToCubic(points[0], points[1], points[2], points[3], ARC_TOLERANCE, 0);
      results.forEach((item) => {
        if (item.type === 'line') {
          code.push(`G1 X${fmt(item.end.x)} Y${fmt(item.end.y)} F${workFeed}`);
        } else {
          const I = item.center.x - item.start.x;
          const J = item.center.y - item.start.y;
          code.push(`${item.cw ? 'G2' : 'G3'} X${fmt(item.end.x)} Y${fmt(item.end.y)} I${fmt(I)} J${fmt(J)} F${workFeed}`);
        }
      });
      lastX = endX;
      lastY = endY;
    }
  });

  if (isLaser) code.push('M5');
  else code.push(`G0 Z${safeZ} F${travelFeed}`);
  code.push('G0 X0 Y0 F' + travelFeed);
  code.push('M2');
  return code.join('\n');
}

// Tokenize path "d" into list of { cmd, args } (cmd keeps case for relative: m,l,a,...). Handles implicit repeated commands.
function tokenizePathD(d) {
  const tokens = [];
  const re = /([MLHVCSQTAZ])|(-?[\d.]+(?:e[-+]?\d+)?)/gi;
  let m;
  while ((m = re.exec(d)) !== null) {
    tokens.push(m[1] != null ? m[1] : parseFloat(m[2]));
  }
  const result = [];
  let i = 0;
  let lastCmd = null;
  const argCount = (c) => ({ M: 2, m: 2, L: 2, l: 2, H: 1, h: 1, V: 1, v: 1, C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2, A: 7, a: 7, Z: 0, z: 0 }[c] ?? 0);
  const implicitNext = (c) => (c === 'M' || c === 'm' ? (c === 'm' ? 'l' : 'L') : c);
  while (i < tokens.length) {
    let cmd = lastCmd;
    if (typeof tokens[i] === 'string') {
      cmd = tokens[i];
      i++;
    }
    if (!cmd) break;
    const n = argCount(cmd);
    if (n === 0) {
      result.push({ cmd, args: [] });
      lastCmd = null;
      continue;
    }
    const args = [];
    while (args.length < n && i < tokens.length && typeof tokens[i] === 'number') {
      args.push(tokens[i++]);
    }
    if (args.length < n) break;
    result.push({ cmd, args });
    lastCmd = implicitNext(cmd);
  }
  return result;
}

// Parse path "d" to segments (line or arc). applyCtm transforms points. Bezier uses adaptive subdivision (0.05).
function parsePathToSegments(d, applyCtm, precision = 0.5) {
  const segments = [];
  const commands = tokenizePathD(d);
  if (commands.length === 0) return segments;
  let x = 0, y = 0;
  let subpathStartX = 0, subpathStartY = 0;
  let lastCp2 = null; // second control of last C/S (for smooth cubic S)
  let lastCp = null;   // control of last Q/T (for smooth quadratic T)
  const cubicBuffer = []; // Option B: buffer 4 C's to detect circle
  const NS = 'http://www.w3.org/2000/svg';
  const isRel = (c) => c === c.toLowerCase();
  const tol = BEZIER_FLATNESS_TOLERANCE;
  const closedEpsilon = 0.001; // path units: allow small float error so 4-C circles are detected

  const pt = (a, b) => applyCtm({ x: a, y: b });
  const flushCubicBuffer = () => {
    cubicBuffer.forEach((cubic) => {
      const out = [];
      adaptiveCubic(cubic.P0, cubic.P1, cubic.P2, cubic.P3, tol, out);
      const points = [pt(cubic.P0.x, cubic.P0.y), ...out.map((p) => pt(p.x, p.y))];
      if (points.length > 1) segments.push({ type: 'line', points });
    });
    cubicBuffer.length = 0;
  };
  const sampleCurve = (pathD) => {
    const temp = document.createElementNS(NS, 'path');
    temp.setAttribute('d', pathD);
    const len = temp.getTotalLength();
    if (len <= 0) return [];
    const points = [];
    for (let t = 0; t <= len; t += precision) {
      const p = temp.getPointAtLength(Math.min(t, len));
      points.push(applyCtm(p));
    }
    return points;
  };

  for (let k = 0; k < commands.length; k++) {
    const { cmd, args } = commands[k];
    if (cmd === 'M' || cmd === 'm') {
      flushCubicBuffer();
      if (isRel(cmd)) { x += args[0]; y += args[1]; } else { x = args[0]; y = args[1]; }
      subpathStartX = x;
      subpathStartY = y;
      lastCp2 = null;
      lastCp = null;
      continue;
    }
    if (cmd === 'L' || cmd === 'l') {
      flushCubicBuffer();
      const x2 = isRel(cmd) ? x + args[0] : args[0];
      const y2 = isRel(cmd) ? y + args[1] : args[1];
      segments.push({ type: 'line', points: [pt(x, y), pt(x2, y2)] });
      x = x2;
      y = y2;
      lastCp2 = null;
      lastCp = null;
      continue;
    }
    if (cmd === 'H' || cmd === 'h') {
      flushCubicBuffer();
      const x2 = isRel(cmd) ? x + args[0] : args[0];
      segments.push({ type: 'line', points: [pt(x, y), pt(x2, y)] });
      x = x2;
      lastCp2 = null;
      lastCp = null;
      continue;
    }
    if (cmd === 'V' || cmd === 'v') {
      flushCubicBuffer();
      const y2 = isRel(cmd) ? y + args[0] : args[0];
      segments.push({ type: 'line', points: [pt(x, y), pt(x, y2)] });
      y = y2;
      lastCp2 = null;
      lastCp = null;
      continue;
    }
    if (cmd === 'A' || cmd === 'a') {
      flushCubicBuffer();
      const rx = args[0], ry = args[1], phiDeg = args[2], fA = Math.round(args[3]), fS = Math.round(args[4]);
      const x2 = isRel(cmd) ? x + args[5] : args[5];
      const y2 = isRel(cmd) ? y + args[6] : args[6];
      lastCp2 = null;
      lastCp = null;
      const arc = svgArcToCenter(x, y, x2, y2, rx, ry, phiDeg, fA, fS);
      const rMax = arc ? Math.max(arc.rx, arc.ry) || 1 : 1;
      const isCircular = arc && (Math.abs(arc.rx - arc.ry) / rMax < 0.01);
      if (arc && isCircular) {
        segments.push({
          type: 'arc',
          start: pt(x, y),
          end: pt(x2, y2),
          center: pt(arc.cx, arc.cy),
          clockwise: arc.clockwise,
        });
      } else if (arc) {
        const pathD = `M${x} ${y} A${rx} ${ry} ${phiDeg} ${fA} ${fS} ${x2} ${y2}`;
        const points = sampleCurve(pathD);
        if (points.length > 1) segments.push({ type: 'line', points });
      }
      x = x2;
      y = y2;
      continue;
    }
    if (cmd === 'Z' || cmd === 'z') {
      flushCubicBuffer();
      lastCp2 = null;
      lastCp = null;
      if (x !== subpathStartX || y !== subpathStartY) {
        segments.push({ type: 'line', points: [pt(x, y), pt(subpathStartX, subpathStartY)] });
      }
      x = subpathStartX;
      y = subpathStartY;
      continue;
    }
    if (cmd === 'C' || cmd === 'c') {
      const x1 = isRel(cmd) ? x + args[0] : args[0], y1 = isRel(cmd) ? y + args[1] : args[1];
      const x2 = isRel(cmd) ? x + args[2] : args[2], y2 = isRel(cmd) ? y + args[3] : args[3];
      const endX = isRel(cmd) ? x + args[4] : args[4];
      const endY = isRel(cmd) ? y + args[5] : args[5];
      lastCp2 = { x: x2, y: y2 };
      lastCp = null;
      const P0 = { x, y }, P1 = { x: x1, y: y1 }, P2 = { x: x2, y: y2 }, P3 = { x: endX, y: endY };
      cubicBuffer.push({ P0, P1, P2, P3 });
      if (cubicBuffer.length === 4) {
        const A = cubicBuffer[0].P0, B = cubicBuffer[0].P3, C = cubicBuffer[1].P3, D = cubicBuffer[2].P3;
        const closed = Math.hypot(cubicBuffer[3].P3.x - A.x, cubicBuffer[3].P3.y - A.y) < closedEpsilon;
        if (closed) {
          const fit = fitCircleFrom4Points(A, B, C, D);
          if (fit) {
            segments.push({ type: 'arc', start: pt(A.x, A.y), end: pt(C.x, C.y), center: pt(fit.cx, fit.cy), clockwise: fit.clockwise });
            segments.push({ type: 'arc', start: pt(C.x, C.y), end: pt(A.x, A.y), center: pt(fit.cx, fit.cy), clockwise: fit.clockwise });
            x = cubicBuffer[3].P3.x;
            y = cubicBuffer[3].P3.y;
            cubicBuffer.length = 0;
            continue;
          }
        }
        for (const cubic of cubicBuffer) {
          const out = [];
          adaptiveCubic(cubic.P0, cubic.P1, cubic.P2, cubic.P3, tol, out);
          const points = [pt(cubic.P0.x, cubic.P0.y), ...out.map((p) => pt(p.x, p.y))];
          if (points.length > 1) segments.push({ type: 'line', points });
        }
        x = cubicBuffer[3].P3.x;
        y = cubicBuffer[3].P3.y;
        cubicBuffer.length = 0;
        continue;
      }
      x = endX;
      y = endY;
      continue;
    }
    if (cmd === 'S' || cmd === 's') {
      flushCubicBuffer();
      const cp2x = isRel(cmd) ? x + args[0] : args[0], cp2y = isRel(cmd) ? y + args[1] : args[1];
      const endX = isRel(cmd) ? x + args[2] : args[2];
      const endY = isRel(cmd) ? y + args[3] : args[3];
      const cp1x = lastCp2 != null ? 2 * x - lastCp2.x : x;
      const cp1y = lastCp2 != null ? 2 * y - lastCp2.y : y;
      lastCp2 = { x: cp2x, y: cp2y };
      lastCp = null;
      const P0 = { x, y }, P1 = { x: cp1x, y: cp1y }, P2 = { x: cp2x, y: cp2y }, P3 = { x: endX, y: endY };
      const out = [];
      adaptiveCubic(P0, P1, P2, P3, tol, out);
      const points = [pt(x, y), ...out.map((p) => pt(p.x, p.y))];
      if (points.length > 1) segments.push({ type: 'line', points });
      x = endX;
      y = endY;
      continue;
    }
    if (cmd === 'Q' || cmd === 'q') {
      flushCubicBuffer();
      const cpx = isRel(cmd) ? x + args[0] : args[0], cpy = isRel(cmd) ? y + args[1] : args[1];
      const endX = isRel(cmd) ? x + args[2] : args[2];
      const endY = isRel(cmd) ? y + args[3] : args[3];
      lastCp = { x: cpx, y: cpy };
      lastCp2 = null;
      const P0 = { x, y }, P1 = { x: cpx, y: cpy }, P2 = { x: endX, y: endY };
      const out = [];
      adaptiveQuad(P0, P1, P2, tol, out);
      const points = [pt(x, y), ...out.map((p) => pt(p.x, p.y))];
      if (points.length > 1) segments.push({ type: 'line', points });
      x = endX;
      y = endY;
      continue;
    }
    if (cmd === 'T' || cmd === 't') {
      flushCubicBuffer();
      const endX = isRel(cmd) ? x + args[0] : args[0];
      const endY = isRel(cmd) ? y + args[1] : args[1];
      const cpx = lastCp != null ? 2 * x - lastCp.x : x;
      const cpy = lastCp != null ? 2 * y - lastCp.y : y;
      lastCp = { x: cpx, y: cpy };
      lastCp2 = null;
      const P0 = { x, y }, P1 = { x: cpx, y: cpy }, P2 = { x: endX, y: endY };
      const out = [];
      adaptiveQuad(P0, P1, P2, tol, out);
      const points = [pt(x, y), ...out.map((p) => pt(p.x, p.y))];
      if (points.length > 1) segments.push({ type: 'line', points });
      x = endX;
      y = endY;
      continue;
    }
  }
  flushCubicBuffer();
  return segments;
}

// Path segment: GGcode-style { type: 'arc'|'line'|'curve', p1, p2, params? } or legacy { type: 'arc', start, end, center, clockwise } / { type: 'line', points }.
function toSegment(poly) {
  if (!poly) return null;
  if (poly.type && poly.p1 && poly.p2 !== undefined) return poly;
  if (poly.type === 'arc' && poly.start && poly.center) return poly;
  if (poly.type === 'line' && poly.points) return poly;
  if (Array.isArray(poly)) return { type: 'line', points: poly };
  return null;
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
      // GGcode-style segment: { type, p1, p2, params? }
      if (seg.p1 && seg.p2 !== undefined) {
        const x1 = seg.p1.x * scaleFactorX, y1 = seg.p1.y * scaleFactorY;
        const x2 = seg.p2.x * scaleFactorX, y2 = seg.p2.y * scaleFactorY;
        if (seg.type === 'arc' && seg.params && typeof seg.params.rx === 'number') {
          const center = findCenterArc(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, seg.params.rx, seg.params.large, seg.params.sweep);
          const cx = center.x * scaleFactorX, cy = center.y * scaleFactorY;
          const r = Math.hypot(x1 - cx, y1 - cy);
          const startAngle = Math.atan2(y1 - cy, x1 - cx);
          const endAngle = Math.atan2(y2 - cy, x2 - cx);
          ctx.arc(cx, cy, r, startAngle, endAngle, seg.params.sweep === 1);
        } else if (seg.type === 'curve' && seg.params) {
          let points;
          if (seg.params.type === 'quadratic') {
            const out = [];
            adaptiveQuad({ x: seg.p1.x, y: seg.p1.y }, { x: seg.params.x1, y: seg.params.y1 }, { x: seg.p2.x, y: seg.p2.y }, BEZIER_FLATNESS_TOLERANCE, out);
            points = [seg.p1, ...out];
          } else {
            const out = [];
            adaptiveCubic({ x: seg.p1.x, y: seg.p1.y }, { x: seg.params.x1, y: seg.params.y1 }, { x: seg.params.x2, y: seg.params.y2 }, { x: seg.p2.x, y: seg.p2.y }, BEZIER_FLATNESS_TOLERANCE, out);
            points = [seg.p1, ...out];
          }
          if (points.length >= 2) {
            ctx.moveTo(points[0].x * scaleFactorX, points[0].y * scaleFactorY);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * scaleFactorX, points[i].y * scaleFactorY);
          }
        } else {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
      } else if (seg.type === 'arc' && seg.start && seg.center) {
        const sx = seg.start.x * scaleFactorX, sy = seg.start.y * scaleFactorY;
        const cx = seg.center.x * scaleFactorX, cy = seg.center.y * scaleFactorY;
        const ex = seg.end.x * scaleFactorX, ey = seg.end.y * scaleFactorY;
        const r = Math.hypot(sx - cx, sy - cy);
        const startAngle = Math.atan2(sy - cy, sx - cx);
        const endAngle = Math.atan2(ey - cy, ex - cx);
        ctx.arc(cx, cy, r, startAngle, endAngle, seg.clockwise);
      } else if (seg.points && seg.points.length >= 2) {
        ctx.moveTo(seg.points[0].x * scaleFactorX, seg.points[0].y * scaleFactorY);
        for (let i = 1; i < seg.points.length; i++) ctx.lineTo(seg.points[i].x * scaleFactorX, seg.points[i].y * scaleFactorY);
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
  const roundGcode = (num) => Math.round(num * 1000) / 1000; // 3 decimals for CNC

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

            // GGcode-style segments: { type: 'arc'|'line'|'curve', p1, p2, params?, d? }
            if (tag === 'path') {
                const d = el.getAttribute('d') || '';
                if (!d.trim()) return;
                const pathSegments = explodePathToSegments(d, applyCtm);
                pathSegments.forEach((seg) => outPaths.push(seg));
                return;
            }

            if (tag === 'circle') {
                const cx = parseFloat(el.getAttribute('cx')) || 0;
                const cy = parseFloat(el.getAttribute('cy')) || 0;
                const r = parseFloat(el.getAttribute('r')) || 0;
                if (r <= 0) return;
                const pStart = applyCtm({ x: cx - r, y: cy });
                const pMid = applyCtm({ x: cx + r, y: cy });
                outPaths.push({ type: 'arc', p1: pStart, p2: pMid, params: { rx: r, ry: r, rot: 0, large: 1, sweep: 1 }, d: `M${cx-r},${cy} A${r} ${r} 0 1 1 ${cx+r} ${cy}` });
                outPaths.push({ type: 'arc', p1: pMid, p2: pStart, params: { rx: r, ry: r, rot: 0, large: 1, sweep: 1 }, d: `M${cx+r},${cy} A${r} ${r} 0 1 1 ${cx-r} ${cy}` });
                return;
            }

            if (tag === 'ellipse') {
                const cx = parseFloat(el.getAttribute('cx')) || 0;
                const cy = parseFloat(el.getAttribute('cy')) || 0;
                const rx = parseFloat(el.getAttribute('rx')) || 0;
                const ry = parseFloat(el.getAttribute('ry')) || 0;
                if (rx <= 0 || ry <= 0) return;
                const d = `M${cx-rx},${cy} A${rx} ${ry} 0 1 1 ${cx+rx} ${cy} A${rx} ${ry} 0 1 1 ${cx-rx} ${cy}`;
                const pathSegments = explodePathToSegments(d, applyCtm);
                pathSegments.forEach((seg) => outPaths.push(seg));
                return;
            }

            if (tag === 'line') {
                const x1 = parseFloat(el.getAttribute('x1')) || 0, y1 = parseFloat(el.getAttribute('y1')) || 0;
                const x2 = parseFloat(el.getAttribute('x2')) || 0, y2 = parseFloat(el.getAttribute('y2')) || 0;
                outPaths.push({ type: 'line', p1: applyCtm({ x: x1, y: y1 }), p2: applyCtm({ x: x2, y: y2 }), params: {} });
                return;
            }
            if (tag === 'rect') {
                const x = parseFloat(el.getAttribute('x')) || 0, y = parseFloat(el.getAttribute('y')) || 0;
                const w = parseFloat(el.getAttribute('width')) || 0, h = parseFloat(el.getAttribute('height')) || 0;
                if (w <= 0 || h <= 0) return;
                const p0 = applyCtm({ x, y });
                const p1 = applyCtm({ x: x + w, y });
                const p2 = applyCtm({ x: x + w, y: y + h });
                const p3 = applyCtm({ x, y: y + h });
                outPaths.push({ type: 'line', p1: p0, p2: p1, params: {} });
                outPaths.push({ type: 'line', p1: p1, p2: p2, params: {} });
                outPaths.push({ type: 'line', p1: p2, p2: p3, params: {} });
                outPaths.push({ type: 'line', p1: p3, p2: p0, params: {} });
                return;
            }
            if (tag === 'polyline' || tag === 'polygon') {
                const pointsAttr = el.getAttribute('points') || '';
                const nums = pointsAttr.trim().split(/[\s,]+/).map(parseFloat).filter((n) => !Number.isNaN(n));
                if (nums.length < 4) return;
                const verts = [];
                for (let i = 0; i + 1 < nums.length; i += 2) verts.push(applyCtm({ x: nums[i], y: nums[i + 1] }));
                for (let i = 0; i < verts.length - 1; i++)
                    outPaths.push({ type: 'line', p1: verts[i], p2: verts[i + 1], params: {} });
                if (tag === 'polygon' && verts.length > 2)
                    outPaths.push({ type: 'line', p1: verts[verts.length - 1], p2: verts[0], params: {} });
                return;
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

  // --- Logic: G-Code Generation (ggcode-style: connectivity-aware, arc fitting) ---
  const generateGCode = async () => {
    if (items.length === 0) return;
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 100));

    try {
      const first = items[0].settings;
      const flatSegments = [];
      items.forEach((item) => {
        const { paths: itemPaths, settings: s, originalSize: os } = item;
        if (!itemPaths || itemPaths.length === 0) return;
        const scaleX = s.width / os.w;
        const scaleY = s.height / os.h;
        const tx = (p) => ({ x: p.x * scaleX + s.posX, y: p.y * scaleY + s.posY });
        itemPaths.forEach((poly) => {
          const seg = toSegment(poly);
          if (!seg) return;
          if (seg.p1 && seg.p2 !== undefined) {
            const p1 = tx(seg.p1);
            const p2 = tx(seg.p2);
            const params = seg.params ? { ...seg.params } : {};
            if (params.rx != null) params.rx = params.rx * scaleX;
            if (params.ry != null) params.ry = params.ry * scaleY;
            if (params.x1 != null) { params.x1 = params.x1 * scaleX + s.posX; params.y1 = params.y1 * scaleY + s.posY; }
            if (params.x2 != null) { params.x2 = params.x2 * scaleX + s.posX; params.y2 = params.y2 * scaleY + s.posY; }
            flatSegments.push({ type: seg.type, p1, p2, params, d: seg.d });
          } else if (seg.type === 'arc' && seg.start && seg.center) {
            const R = distPt(seg.start, seg.center);
            flatSegments.push({
              type: 'arc',
              p1: tx(seg.start),
              p2: tx(seg.end),
              params: { rx: R * scaleX, ry: R * scaleY, large: 0, sweep: seg.clockwise ? 0 : 1 },
              d: null,
            });
          } else if (seg.points && seg.points.length >= 2) {
            for (let i = 0; i < seg.points.length - 1; i++) {
              flatSegments.push({ type: 'line', p1: tx(seg.points[i]), p2: tx(seg.points[i + 1]), params: {}, d: null });
            }
          }
        });
      });

      const code = ggcodeGenerateGCode(
        flatSegments,
        1,
        first.workSpeed,
        first.travelSpeed,
        first.zUp,
        first.zDown,
        false
      );

      const blob = new Blob([code], { type: "text/plain" });
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
