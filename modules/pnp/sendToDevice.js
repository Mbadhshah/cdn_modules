/**
 * sendToDevice.js — Cloud module: upload G-code to ESP over WiFi.
 *
 * USE FROM CLOUD: Host this file on your CDN and load it from any page.
 * No bundling required. Same file works for plotter, gripper, pick&place, laser, etc.
 *
 * Load: <script src="https://your-cdn.com/cdn_modules/sendToDevice.js"></script>
 * Call: sendToDevice(gcodeString, filename, espIp)
 *   - gcodeString: full G-code text
 *   - filename: e.g. 'plot.gcode', 'gripper/run.gcode' (optional, default 'job.gcode')
 *   - espIp: e.g. '192.168.4.1'
 * Returns: Promise<{ ok, status?, message? }>
 */
(function (global) {
  'use strict';

  const UPLOAD_PATH = '/upload';
  const DEFAULT_FILENAME = 'job.gcode';

  /**
   * Upload G-code string to ESP as a file via HTTP POST (multipart/form-data).
   * @param {string} gcodeString - The G-code content
   * @param {string} [filename] - Filename for the upload (e.g. 'plot.gcode', 'gripper/run.gcode'). Default 'job.gcode'
   * @param {string} espIp - ESP IP (e.g. '192.168.4.1')
   * @returns {Promise<{ ok: boolean, status?: number, message?: string }>}
   */
  function sendToDevice(gcodeString, filename, espIp) {
    if (typeof gcodeString !== 'string') {
      return Promise.reject(new Error('sendToDevice: gcodeString must be a string'));
    }
    if (!espIp || typeof espIp !== 'string') {
      return Promise.reject(new Error('sendToDevice: espIp is required (e.g. "192.168.4.1")'));
    }

    const name = (typeof filename === 'string' && filename.trim()) ? filename.trim() : DEFAULT_FILENAME;
    const url = espIp.replace(/\/$/, '') + UPLOAD_PATH;
    const file = new File([gcodeString], name, { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', file);

    return fetch(url, {
      method: 'POST',
      body: formData,
      mode: 'cors',
    })
      .then(function (response) {
        if (response.ok) {
          return { ok: true, status: response.status };
        }
        return response.text().then(function (text) {
          return {
            ok: false,
            status: response.status,
            message: text || response.statusText,
          };
        });
      })
      .catch(function (err) {
        return {
          ok: false,
          message: err && err.message ? err.message : 'Network or CORS error',
        };
      });
  }

  // Expose globally for script-tag usage (cloud / any page)
  global.sendToDevice = sendToDevice;

  // Support ES module / bundler if present
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sendToDevice;
  }
  if (typeof define === 'function' && define.amd) {
    define([], function () {
      return sendToDevice;
    });
  }
})(typeof window !== 'undefined' ? window : this);
