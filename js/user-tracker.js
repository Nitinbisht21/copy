/**
 * Mobile GPS Tracker Client Engine
 * Transmits real-time HTML5 Geolocation API telemetry to the Flask backend
 * Features:
 *   - Continuous background tracking via Screen Wake Lock, Web Worker heartbeat, and Audio keep-alive
 *   - Persistent session memory: Auto-resumes tracking upon page refresh
 *   - Instant location restoration: Coordinates and stats appear immediately without blank screens
 *   - Periodic heartbeat pings to ensure device never drops to offline on the Admin Panel
 *   - Multi-tier storage persistence and multi-device slot support (?device=2, ?slot=2)
 */

(function () {
  'use strict';

  // URL slot handling for testing multiple devices on same browser (?device=2 or ?slot=2 or ?new=1)
  const urlParams = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const deviceSlot = urlParams.get('device') || urlParams.get('slot') || '';
  const isForcedNew = urlParams.get('new') === '1' || urlParams.get('reset') === '1';
  const slotSuffix = deviceSlot ? `_slot_${deviceSlot}` : '';

  // Constants & Storage Keys
  const STORAGE_KEYS = {
    DEVICE_ID: `vf_device_id${slotSuffix}`,
    DEVICE_NAME: `vf_device_name${slotSuffix}`,
    CLIENT_UUID: `vf_client_uuid${slotSuffix}`,
    AUTH_TOKEN: `vf_auth_token${slotSuffix}`,
    USER_ID: 'vf_user_id',
    FINGERPRINT: 'vf_device_fingerprint',
    TRACKING_ACTIVE: `vf_tracking_active${slotSuffix}`,
    LAST_POSITION: `vf_last_position${slotSuffix}`,
    LAST_GEOFENCE: `vf_last_geofence${slotSuffix}`,
    LAST_SYNC_TIME: `vf_last_sync_time${slotSuffix}`
  };

  const API = {
    REGISTER_DEVICE: '/api/devices/register',
    TELEMETRY: '/api/telemetry',
    DEVICE: (id) => `/api/devices/${id}`,
    PING: (id) => `/api/devices/${id}/ping`
  };

  const TELEMETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes (120,000 ms) data footprint interval

  // Multi-tier storage persistence (LocalStorage -> SessionStorage -> Persistent Cookie)
  function getStoredValue(key) {
    try {
      let val = localStorage.getItem(key);
      if (val && val !== 'null' && val !== 'undefined') return val;
      val = sessionStorage.getItem(key);
      if (val && val !== 'null' && val !== 'undefined') return val;
      const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + key + '=([^;]*)'));
      if (match) return decodeURIComponent(match[1]);
    } catch (e) {}
    return null;
  }

  function setStoredValue(key, val, persistCookie = false) {
    try {
      if (val !== null && val !== undefined) {
        localStorage.setItem(key, val);
        sessionStorage.setItem(key, val);
        if (persistCookie) {
          // 1-year persistent cookie with SameSite=Lax for survival across webviews
          document.cookie = `${key}=${encodeURIComponent(val)}; max-age=31536000; path=/; SameSite=Lax`;
        }
      } else {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
        if (persistCookie) {
          document.cookie = `${key}=; max-age=0; path=/`;
        }
      }
    } catch (e) {}
  }

  // Generates a cryptographically unique persistent client installation UUID
  function generateClientUuid() {
    let rand = '';
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    } else {
      rand = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
    }
    return `cli_${rand}_${Date.now().toString(36)}`;
  }

  function getOrCreateClientUuid(key) {
    if (isForcedNew) {
      const fresh = generateClientUuid();
      setStoredValue(key, fresh, true);
      return fresh;
    }
    let stored = getStoredValue(key);
    if (stored && stored.startsWith('cli_')) return stored;
    const fresh = generateClientUuid();
    setStoredValue(key, fresh, true);
    return fresh;
  }

  // Generates a deterministic device/browser hardware fingerprint
  function generateDeviceFingerprint() {
    let stored = getStoredValue(STORAGE_KEYS.FINGERPRINT);
    if (stored && stored.startsWith('fp_')) return stored;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 40;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.textBaseline = 'top';
        ctx.font = "14px 'Arial'";
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('VirtualFence#1', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('VirtualFence#1', 4, 17);
      }
      const canvasHash = canvas.toDataURL ? canvas.toDataURL() : '';
      const screenData = `${screen.width}x${screen.height}x${screen.colorDepth}x${window.devicePixelRatio || 1}`;
      const hw = `${navigator.hardwareConcurrency || 4}_${navigator.platform || ''}_${navigator.language || ''}`;
      const tz = Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
      const raw = `${canvasHash}:::${screenData}:::${hw}:::${tz}`;

      // djb2 hash
      let hash = 5381;
      for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash) + raw.charCodeAt(i);
        hash = hash & hash;
      }
      const fp = 'fp_' + Math.abs(hash).toString(36);
      setStoredValue(STORAGE_KEYS.FINGERPRINT, fp);
      return fp;
    } catch (e) {
      const fallback = 'fp_' + (navigator.userAgent || 'unknown').replace(/\W/g, '').slice(0, 16);
      setStoredValue(STORAGE_KEYS.FINGERPRINT, fallback);
      return fallback;
    }
  }

  // =========================================================================
  // BACKGROUND HELPERS: LIGHTWEIGHT AUDIO KEEP-ALIVE & WEB WORKER HEARTBEAT
  // =========================================================================

  class BackgroundAudioKeeper {
    constructor() {
      this.audio = null;
      this.isActive = false;
    }

    start() {
      if (this.isActive) return;
      this.isActive = true;

      // Ultra-lightweight 1-second silent WAV base64 loop
      // Uses 0% CPU and 0 MB RAM, avoids AudioContext buffer leakage
      try {
        if (!this.audio) {
          const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
          this.audio = new Audio(silentWav);
          this.audio.loop = true;
          this.audio.volume = 0.001;
        }
        const p = this.audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch (e) {}
    }

    stop() {
      this.isActive = false;
      if (this.audio) {
        try {
          this.audio.pause();
          this.audio.currentTime = 0;
        } catch (e) {}
      }
    }
  }

  function createBackgroundWorker(onTick) {
    try {
      const code = `
        var timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (!timer) {
              timer = setInterval(function() {
                self.postMessage('tick');
              }, 15000); // tick every 15 seconds
            }
          } else if (e.data === 'stop') {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
          }
        };
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const worker = new Worker(blobUrl);
      URL.revokeObjectURL(blobUrl);
      worker.onmessage = function(e) {
        if (e.data === 'tick' && typeof onTick === 'function') {
          onTick();
        }
      };
      return worker;
    } catch (err) {
      console.warn('Worker keeper fallback:', err);
      return null;
    }
  }

  // =========================================================================
  // PICTURE-IN-PICTURE (PIP) FLOATING MINI-TRACKER ENGINE
  // Allows continuous GPS tracking over other apps (WhatsApp, Maps, Home screen)
  // When PiP is open, mobile Chrome and desktop browsers treat the tab as FOREGROUND
  // so navigator.geolocation.watchPosition is NEVER throttled or suspended!
  // =========================================================================

  class PipTracker {
    constructor(tracker) {
      this.tracker = tracker;
      this.canvas = null;
      this.ctx = null;
      this.video = null;
      this.stream = null;
      this.isPipActive = false;
      this.renderInterval = null;
      this.btnPip = null;
      this.pipBadge = null;
      this.chkAutoPip = null;
      this.init();
    }

    isSupported() {
      return Boolean(document.pictureInPictureEnabled && HTMLVideoElement.prototype.requestPictureInPicture);
    }

    init() {
      this.canvas = document.getElementById('pip-canvas');
      this.video = document.getElementById('pip-video');
      this.btnPip = document.getElementById('btn-toggle-pip');
      this.pipBadge = document.getElementById('pip-badge');
      this.chkAutoPip = document.getElementById('chk-auto-pip');

      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'pip-canvas';
        this.canvas.width = 360;
        this.canvas.height = 200;
        this.canvas.style.display = 'none';
        document.body.appendChild(this.canvas);
      }
      this.ctx = this.canvas.getContext('2d');

      if (!this.video) {
        this.video = document.createElement('video');
        this.video.id = 'pip-video';
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.style.display = 'none';
        document.body.appendChild(this.video);
      }

      // Restore auto-pip stored preference (defaults to false to prevent RAM leak)
      const storedAutoPip = getStoredValue('vf_auto_pip');
      if (this.chkAutoPip) {
        this.chkAutoPip.checked = storedAutoPip === 'true';
        this.chkAutoPip.addEventListener('change', () => {
          setStoredValue('vf_auto_pip', this.chkAutoPip.checked ? 'true' : 'false');
        });
      }

      // Button toggle listener
      if (this.btnPip) {
        if (!this.isSupported()) {
          this.btnPip.style.opacity = '0.6';
          this.btnPip.title = 'Picture-in-Picture not supported on this browser version. Keep the tab open to track.';
        }
        this.btnPip.addEventListener('click', async (e) => {
          e.preventDefault();
          await this.togglePiP();
        });
      }

      // Track PiP window lifecycle
      this.video.addEventListener('enterpictureinpicture', () => {
        this.isPipActive = true;
        this.updateUI(true);
        if (this.tracker && this.tracker.networkStatus) {
          this.tracker.networkStatus.textContent = 'Floating Mini-Tracker Active • Tracking over other apps';
        }
      });

      this.video.addEventListener('leavepictureinpicture', () => {
        this.stopStream();
      });
    }

    renderFrame() {
      // ONLY render if PiP is currently active; prevents idle canvas drawing and memory leaks
      if (!this.isPipActive || !this.ctx) return;
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const pos = this.tracker.lastPosition;
      const isTracking = this.tracker.isTracking;

      // Dark background gradient
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#0a0e17');
      grad.addColorStop(1, '#0f172a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Outer accent border
      ctx.strokeStyle = isTracking ? 'rgba(16, 185, 129, 0.5)' : 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);

      // Header Banner
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(3, 3, w - 6, 34);

      // Pulsing Green/Red Beacon Dot
      const pulsePhase = (Date.now() % 1600) / 1600;
      const r = 5 + (isTracking ? Math.sin(pulsePhase * Math.PI) * 2 : 0);
      ctx.beginPath();
      ctx.arc(20, 20, Math.max(3, r), 0, 2 * Math.PI);
      ctx.fillStyle = isTracking ? '#10b981' : '#ef4444';
      ctx.fill();

      // Header Text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
      ctx.fillText('VIRTUAL FENCE TRACKER', 34, 24);

      // Device Tag
      const devName = this.tracker.deviceName || this.tracker.deviceId || 'Phone';
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(devName.slice(0, 16), w - 14, 24);
      ctx.textAlign = 'left';

      // Coordinates Line
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('GPS COORDINATES', 16, 56);

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 16px monospace';
      if (pos && pos.latitude !== undefined) {
        ctx.fillText(`${pos.latitude.toFixed(5)}°, ${pos.longitude.toFixed(5)}°`, 16, 78);
      } else {
        ctx.fillText(isTracking ? 'Acquiring GPS Fix...' : 'Tracking Paused', 16, 78);
      }

      // Telemetry: Accuracy & Speed
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '11px system-ui, sans-serif';
      const accStr = pos && pos.accuracy ? `Acc: ±${pos.accuracy}m` : 'Acc: —';
      const spdStr = pos && pos.speed !== undefined ? `Speed: ${pos.speed} km/h` : 'Speed: 0 km/h';
      ctx.fillText(`${accStr}   •   ${spdStr}`, 16, 104);

      // Fence Badge
      const fenceText = (this.tracker.statGeofence && this.tracker.statGeofence.textContent) || 'Outside Geofences';
      const isInside = fenceText.includes('Inside');
      const isFlagged = fenceText.includes('Flagged') || fenceText.includes('Outside');

      const bgColor = isInside ? 'rgba(16, 185, 129, 0.18)' : (isFlagged ? 'rgba(239, 68, 68, 0.22)' : 'rgba(245, 158, 11, 0.18)');
      const borderColor = isInside ? 'rgba(16, 185, 129, 0.45)' : (isFlagged ? 'rgba(239, 68, 68, 0.55)' : 'rgba(245, 158, 11, 0.45)');
      const textColor = isInside ? '#34d399' : (isFlagged ? '#f87171' : '#fbbf24');

      ctx.fillStyle = bgColor;
      ctx.fillRect(16, 118, w - 32, 26);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(16, 118, w - 32, 26);

      ctx.fillStyle = textColor;
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText(fenceText.slice(0, 38), 24, 135);

      // Footer
      ctx.fillStyle = '#64748b';
      ctx.font = '10px system-ui, sans-serif';
      const timeStr = new Date().toLocaleTimeString();
      ctx.fillText(`Active Over Apps • ${timeStr}`, 16, 180);

      ctx.textAlign = 'right';
      ctx.fillStyle = isTracking ? '#38bdf8' : '#94a3b8';
      ctx.fillText(isTracking ? '● LIVE STREAMING' : 'STANDBY', w - 16, 180);
      ctx.textAlign = 'left';
    }

    async startStream() {
      this.isPipActive = true;
      this.renderFrame();
      if (!this.stream) {
        try {
          this.stream = this.canvas.captureStream(1); // 1 fps is lightweight, zero memory leak
          this.video.srcObject = this.stream;
          await this.video.play();
        } catch (e) {
          console.warn('PiP captureStream notice:', e);
        }
      }
      if (!this.renderInterval) {
        this.renderInterval = setInterval(() => this.renderFrame(), 1000);
      }
    }

    stopStream() {
      if (this.renderInterval) {
        clearInterval(this.renderInterval);
        this.renderInterval = null;
      }
      if (this.stream) {
        try {
          this.stream.getTracks().forEach(t => t.stop());
        } catch (e) {}
        this.stream = null;
      }
      if (this.video) {
        try {
          this.video.pause();
          this.video.srcObject = null;
        } catch (e) {}
      }
      this.isPipActive = false;
      this.updateUI(false);
    }

    async togglePiP() {
      if (!this.isSupported()) {
        alert('Floating Picture-in-Picture is not supported in this browser version. Keep the tab open to track.');
        return false;
      }
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          this.stopStream();
          return false;
        } else {
          await this.startStream();
          await this.video.requestPictureInPicture();
          return true;
        }
      } catch (err) {
        this.stopStream();
        console.warn('Toggle PiP notice:', err);
        return false;
      }
    }

    async autoEnableIfRequested() {
      if (!this.isSupported()) return;
      const shouldAuto = this.chkAutoPip ? this.chkAutoPip.checked : false;
      if (shouldAuto && !document.pictureInPictureElement) {
        try {
          await this.startStream();
          await this.video.requestPictureInPicture();
        } catch (e) {
          this.stopStream();
          console.log('[PiP] Auto-launch notice (gesture needed):', e);
        }
      }
    }

    stop() {
      if (document.pictureInPictureElement && document.pictureInPictureElement === this.video) {
        document.exitPictureInPicture().catch(() => {});
      }
      this.stopStream();
    }

    updateUI(isActive) {
      if (this.btnPip) {
        if (isActive) {
          this.btnPip.classList.add('pip-active');
          this.btnPip.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>
              <rect x="11" y="11" width="9" height="7" rx="1.5"/>
            </svg>
            <span id="btn-pip-text">Floating Mini-Tracker Active (Over Other Apps)</span>
          `;
        } else {
          this.btnPip.classList.remove('pip-active');
          this.btnPip.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="3"/>
              <rect x="11" y="11" width="9" height="7" rx="1.5" fill="currentColor"/>
            </svg>
            <span id="btn-pip-text">📌 Floating Mini-Tracker (Works Over Other Apps)</span>
          `;
        }
      }
      if (this.pipBadge) {
        this.pipBadge.style.display = isActive ? 'inline-block' : 'none';
      }
    }
  }

  // =========================================================================
  // MAIN USER TRACKER CLIENT
  // =========================================================================

  class UserTracker {
    constructor() {
      this.clientUuid = getOrCreateClientUuid(STORAGE_KEYS.CLIENT_UUID);
      this.fingerprint = generateDeviceFingerprint();
      this.deviceId = isForcedNew ? null : (getStoredValue(STORAGE_KEYS.DEVICE_ID) || null);
      this.deviceName = isForcedNew ? null : (getStoredValue(STORAGE_KEYS.DEVICE_NAME) || null);
      this.token = getStoredValue(STORAGE_KEYS.AUTH_TOKEN) || null;
      this.userId = getStoredValue(STORAGE_KEYS.USER_ID) || 'anon_user';

      // Read restored tracking state & cached position across page refreshes
      this.wasTrackingActive = !isForcedNew && (getStoredValue(STORAGE_KEYS.TRACKING_ACTIVE) === 'true');
      this.isTracking = false;
      this.watchId = null;
      this.wakeLock = null;

      // Restore last known position immediately so screen is NEVER blank on refresh!
      let cachedPos = null;
      try {
        const rawPos = getStoredValue(STORAGE_KEYS.LAST_POSITION);
        if (rawPos) cachedPos = JSON.parse(rawPos);
      } catch (e) {}

      this.lastPosition = cachedPos;
      this.lastSyncTime = Number(getStoredValue(STORAGE_KEYS.LAST_SYNC_TIME)) || null;
      this.lastTelemetrySendTime = 0;
      this.lastPingSendTime = 0;
      this.isOfflineDueToFence = false;
      this.offlineQueue = [];
      this.isSending = false;
      this.forceImmediateSync = false;

      // Background helpers
      this.audioKeeper = new BackgroundAudioKeeper();
      this.worker = createBackgroundWorker(() => this.handleBackgroundHeartbeat());
      this.pipTracker = new PipTracker(this);

      this.initElements();
      this.bindEvents();

      // Display cached position immediately on DOM load!
      if (this.lastPosition) {
        this.updateTelemetryDisplay(this.lastPosition);
        const cachedFence = getStoredValue(STORAGE_KEYS.LAST_GEOFENCE);
        if (cachedFence && this.statGeofence) {
          this.statGeofence.textContent = cachedFence;
        }
        if (this.networkStatus) {
          this.networkStatus.textContent = this.wasTrackingActive
            ? 'Session Restored • Resuming GPS tracking...'
            : 'Last Known Location Restored';
        }
      }

      this.initDevice();
    }

    initElements() {
      this.statusPulse = document.getElementById('status-pulse');
      this.statusLabel = document.getElementById('status-label');
      this.networkStatus = document.getElementById('network-status');
      this.deviceBadge = document.getElementById('device-badge');
      this.bgBadge = document.getElementById('bg-badge');
      this.btnToggleTrack = document.getElementById('btn-toggle-track');
      this.btnTrackIcon = document.getElementById('btn-track-icon');
      this.btnTrackText = document.getElementById('btn-track-text');
      this.userDisplayName = document.getElementById('user-display-name');

      this.statLat = document.getElementById('stat-lat');
      this.statLng = document.getElementById('stat-lng');
      this.statAccuracy = document.getElementById('stat-accuracy');
      this.statSpeed = document.getElementById('stat-speed');
      this.statGeofence = document.getElementById('stat-geofence');
      this.statLastSync = document.getElementById('stat-last-sync');
      this.statSyncCountdown = document.getElementById('stat-sync-countdown');

      this.deviceModal = document.getElementById('device-modal');
      this.deviceForm = document.getElementById('device-form');
      this.inputDeviceName = document.getElementById('input-device-name');
      this.inputDeviceId = document.getElementById('input-device-id');
      this.btnCloseDeviceModal = document.getElementById('btn-close-device-modal');
      this.btnUserProfile = document.getElementById('btn-user-profile');
      this.btnRegisterNewDevice = document.getElementById('btn-register-new-device');
    }

    bindEvents() {
      this.btnToggleTrack.addEventListener('click', async () => {
        if (this.isTracking) {
          this.stopTracking();
        } else {
          this.startTracking(false);
        }
      });

      this.btnUserProfile.addEventListener('click', () => {
        this.openDeviceModal();
      });

      this.btnCloseDeviceModal.addEventListener('click', () => {
        this.closeDeviceModal();
      });

      if (this.btnRegisterNewDevice) {
        this.btnRegisterNewDevice.addEventListener('click', () => {
          this.registerAsBrandNewDevice();
        });
      }

      this.deviceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = this.inputDeviceName.value.trim();
        const customId = this.inputDeviceId.value.trim() || null;
        if (name) {
          this.registerDeviceOnBackend(name, customId);
        }
      });

      // Network online/offline recovery
      window.addEventListener('online', () => {
        this.networkStatus.textContent = 'Network Online';
        this.flushOfflineQueue();
      });

      window.addEventListener('offline', () => {
        this.networkStatus.textContent = 'Network Offline (Buffering GPS)';
      });

      // Handle Page Visibility Change (Minimizing/Restoring browser tab)
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          if (this.isTracking) {
            await this.requestWakeLock();
            this.forceImmediateSync = true;
          }
        } else {
          // Tab is minimized or hidden: ensure audio keeper is running to prevent OS sleep
          if (this.isTracking) {
            this.audioKeeper.start();
          }
        }
      });

      // Re-acquire Screen Wake Lock on user touch/click
      const reacquireWakeLock = () => {
        if (this.isTracking && !this.wakeLock) {
          this.requestWakeLock();
        }
      };
      document.addEventListener('touchstart', reacquireWakeLock, { passive: true });
      document.addEventListener('click', reacquireWakeLock, { passive: true });

      // Update "Last updated X seconds ago" counter every second
      if (window._vfSyncInterval) clearInterval(window._vfSyncInterval);
      window._vfSyncInterval = setInterval(() => this.updateSyncElapsed(), 1000);

      // Instantly mark device OFFLINE if mobile browser tab is closed or navigated away
      const sendOfflineBeacon = () => {
        if (this.isTracking && this.deviceId) {
          const payload = JSON.stringify({
            client_uuid: this.clientUuid,
            status: 'offline',
            tracking_active: false
          });
          if (navigator.sendBeacon) {
            navigator.sendBeacon(API.PING(this.deviceId), new Blob([payload], { type: 'application/json' }));
          }
        }
      };

      window.addEventListener('pagehide', sendOfflineBeacon);
      window.addEventListener('beforeunload', sendOfflineBeacon);
    }

    async registerAsBrandNewDevice() {
      // Allocate a fresh persistent client UUID and reset device identity
      this.clientUuid = generateClientUuid();
      setStoredValue(STORAGE_KEYS.CLIENT_UUID, this.clientUuid);
      setStoredValue(STORAGE_KEYS.DEVICE_ID, null);
      setStoredValue(STORAGE_KEYS.DEVICE_NAME, null);
      setStoredValue(STORAGE_KEYS.TRACKING_ACTIVE, 'false');
      setStoredValue(STORAGE_KEYS.LAST_POSITION, null);
      this.deviceId = null;
      this.deviceName = null;
      this.lastPosition = null;
      this.wasTrackingActive = false;

      if (this.deviceBadge) this.deviceBadge.textContent = 'CONNECTING...';
      if (this.userDisplayName) this.userDisplayName.textContent = 'Connecting...';
      if (this.inputDeviceName) this.inputDeviceName.value = '';
      if (this.inputDeviceId) this.inputDeviceId.value = '';
      this.networkStatus.textContent = 'Registering new phone slot...';

      await this.registerDeviceOnBackend(null, null);
    }

    detectPlatform() {
      const ua = navigator.userAgent || '';
      if (/android/i.test(ua)) return 'android';
      if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
      return 'browser';
    }

    async initDevice() {
      // If returning device, pass its known name and ID.
      // If new, pass null so the server auto-increments ("Device 1", "Device 2"...)
      await this.registerDeviceOnBackend(this.deviceName, this.deviceId);
      if (this.deviceBadge) this.deviceBadge.textContent = this.deviceId || 'CONNECTING...';
      if (this.userDisplayName) this.userDisplayName.textContent = this.deviceName || 'Connecting...';
      if (this.inputDeviceName) this.inputDeviceName.value = this.deviceName || '';
      if (this.inputDeviceId) this.inputDeviceId.value = this.deviceId || '';

      // If tracking was active before page refresh, auto-resume tracking seamlessly!
      if (this.wasTrackingActive) {
        console.log('[UserTracker] Auto-resuming GPS tracking from previous session...');
        this.startTracking(true);
      }
    }

    async registerDeviceOnBackend(name, customId = null) {
      try {
        const payload = {
          device_name: name || undefined,
          platform: this.detectPlatform(),
          user_id: this.userId,
          device_id: customId || this.deviceId || undefined,
          client_uuid: this.clientUuid,
          fingerprint: this.fingerprint
        };

        const res = await fetch(API.REGISTER_DEVICE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const device = await res.json();
          this.deviceId = device.device_id;
          this.deviceName = device.device_name;
          setStoredValue(STORAGE_KEYS.DEVICE_ID, this.deviceId, true);
          setStoredValue(STORAGE_KEYS.DEVICE_NAME, this.deviceName, true);

          if (this.deviceBadge) this.deviceBadge.textContent = this.deviceId;
          if (this.userDisplayName) this.userDisplayName.textContent = this.deviceName;
          if (this.inputDeviceName) this.inputDeviceName.value = this.deviceName;
          if (this.inputDeviceId) this.inputDeviceId.value = this.deviceId;

          // If local cache had no coordinates, but server has last_location, restore it immediately!
          if (device.last_location && (!this.lastPosition || !this.lastPosition.latitude)) {
            this.lastPosition = {
              device_id: this.deviceId,
              device_name: this.deviceName,
              client_uuid: this.clientUuid,
              latitude: Number(device.last_location.latitude),
              longitude: Number(device.last_location.longitude),
              accuracy: Number(device.last_location.accuracy || 10),
              speed: Number(device.last_location.speed || 0),
              heading: Number(device.last_location.heading || 0),
              timestamp: device.last_location.timestamp || new Date().toISOString()
            };
            setStoredValue(STORAGE_KEYS.LAST_POSITION, JSON.stringify(this.lastPosition));
            this.updateTelemetryDisplay(this.lastPosition);
            if (device.current_fence && this.statGeofence) {
              this.statGeofence.textContent = device.current_fence;
            }
          }

          this.closeDeviceModal();
          this.networkStatus.textContent = device.reconnected ? 'Device Reconnected (Session Preserved)' : 'Device Connected & Ready';
        } else {
          const err = await res.json();
          console.warn('Registration notice:', err.error);
        }
      } catch (err) {
        // Fallback for offline initialization
        if (!this.deviceId) {
          this.deviceId = customId || `DEV_${this.clientUuid.slice(4, 10).toUpperCase()}`;
          this.deviceName = name || 'Device 1';
          setStoredValue(STORAGE_KEYS.DEVICE_ID, this.deviceId);
          setStoredValue(STORAGE_KEYS.DEVICE_NAME, this.deviceName);
          if (this.deviceBadge) this.deviceBadge.textContent = this.deviceId;
          if (this.userDisplayName) this.userDisplayName.textContent = this.deviceName;
        }
        this.closeDeviceModal();
      }
    }

    openDeviceModal() {
      if (this.inputDeviceName) this.inputDeviceName.value = this.deviceName || '';
      if (this.inputDeviceId) this.inputDeviceId.value = this.deviceId || '';
      if (this.deviceModal) this.deviceModal.classList.remove('hidden');
    }

    closeDeviceModal() {
      if (this.deviceModal) this.deviceModal.classList.add('hidden');
    }

    // =========================================================================
    // GPS WATCHER & SCREEN WAKE LOCK & BACKGROUND WORKER
    // =========================================================================

    async startTracking(isAutoResume = false) {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your mobile browser.');
        return;
      }

      this.isTracking = true;
      setStoredValue(STORAGE_KEYS.TRACKING_ACTIVE, 'true');
      this.lastTelemetrySendTime = 0;
      this.isOfflineDueToFence = false;

      // If we already have a restored position, show active status smoothly without jarring reset
      if (this.lastPosition && this.lastPosition.latitude) {
        this.updateUIState('active');
        this.networkStatus.textContent = isAutoResume
          ? 'Tracking Active (Restored) • Updating GPS...'
          : 'Tracking Active • Updating GPS...';
      } else {
        this.updateUIState('seeking');
        this.networkStatus.textContent = 'Acquiring GPS Fix...';
      }

      // Request Screen Wake Lock so screen does not lock and throttle GPS
      await this.requestWakeLock();

      // Start Background Audio Keeper & Background Worker (PiP stream starts only on user toggle)
      this.audioKeeper.start();
      if (this.worker) this.worker.postMessage('start');

      // Immediately notify backend that device is ONLINE and actively tracking
      if (this.deviceId) {
        fetch(API.PING(this.deviceId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_uuid: this.clientUuid,
            status: 'online',
            tracking_active: true
          })
        }).catch(() => {});
      }

      const options = {
        enableHighAccuracy: true,
        maximumAge: 3000, // 3-second cache to prevent sensor thrashing and CPU burn
        timeout: 20000
      };

      // Trigger immediate one-shot satellite fix
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => this.handlePosition(pos),
          (err) => {},
          options
        );
      } catch (e) {}

      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
      }

      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.handlePosition(pos),
        (err) => this.handlePositionError(err),
        options
      );
    }

    stopTracking(reason = '') {
      this.isTracking = false;
      this.wasTrackingActive = false;
      setStoredValue(STORAGE_KEYS.TRACKING_ACTIVE, 'false');
      this.lastTelemetrySendTime = 0;
      this.isOfflineDueToFence = false;

      // Immediately notify backend that device is now OFFLINE and stopped tracking
      if (this.deviceId) {
        const payload = JSON.stringify({
          client_uuid: this.clientUuid,
          status: 'offline',
          tracking_active: false
        });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(API.PING(this.deviceId), new Blob([payload], { type: 'application/json' }));
          } else {
            fetch(API.PING(this.deviceId), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payload
            }).catch(() => {});
          }
        } catch (e) {
          fetch(API.PING(this.deviceId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
          }).catch(() => {});
        }
      }

      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }

      this.releaseWakeLock();
      this.audioKeeper.stop();
      if (this.worker) this.worker.postMessage('stop');
      if (this.pipTracker) this.pipTracker.stop();

      this.updateUIState('stopped');
      this.networkStatus.textContent = reason || 'Tracking Stopped (Device Offline)';
      if (this.statSyncCountdown) {
        this.statSyncCountdown.textContent = 'Next upload: Standby (Offline)';
        this.statSyncCountdown.style.color = '#94a3b8';
      }
    }

    async requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          this.wakeLock = await navigator.wakeLock.request('screen');
        } catch (e) {
          console.warn('Wake Lock request notice:', e);
        }
      }
    }

    releaseWakeLock() {
      if (this.wakeLock !== null) {
        try {
          this.wakeLock.release();
        } catch (e) {}
        this.wakeLock = null;
      }
    }

    // Background worker heartbeat called every 15s to keep device alive
    async handleBackgroundHeartbeat() {
      if (!this.isTracking) return;

      const now = Date.now();

      // 1. If tab is in background, re-assert audio keep-alive (only fetch GPS if not already cached)
      if (document.visibilityState === 'hidden') {
        this.audioKeeper.start();
        if (!this.lastPosition && navigator.geolocation) {
          try {
            navigator.geolocation.getCurrentPosition(
              (pos) => this.handlePosition(pos),
              () => {},
              { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
            );
          } catch (e) {}
        }
      }

      // 2. Check 2-minute database cadence while hidden: If 2 minutes elapsed, send current coordinates
      const timeSinceTelemetry = now - this.lastTelemetrySendTime;
      const timeSincePing = now - this.lastPingSendTime;

      if (this.lastPosition && this.lastPosition.latitude && timeSinceTelemetry >= TELEMETRY_INTERVAL_MS) {
        await this.sendTelemetry(this.lastPosition);
      } else if (this.deviceId && timeSinceTelemetry > 25000 && timeSincePing > 25000) {
        // 3. Heartbeat ping: Keep device ONLINE on server
        this.lastPingSendTime = now;
        try {
          await fetch(API.PING(this.deviceId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_uuid: this.clientUuid,
              status: 'online',
              tracking_active: true
            })
          });
        } catch (e) {}
      }

      // 4. Flush offline queue if any
      if (this.offlineQueue.length > 0 && navigator.onLine) {
        this.flushOfflineQueue();
      }
    }

    handlePosition(position) {
      if (!this.isTracking || !position || !position.coords) return;

      const now = Date.now();
      // Throttle high-frequency GPS sensor ticks to at most once per 800ms
      // Eliminates UI thread lag, stops memory thrashing, drops RAM to < 50MB
      if (this.lastPosUpdateTime && (now - this.lastPosUpdateTime < 800)) {
        return;
      }
      this.lastPosUpdateTime = now;

      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      const timestamp = new Date(position.timestamp || now).toISOString();

      this.lastPosition = {
        device_id: this.deviceId,
        device_name: this.deviceName,
        client_uuid: this.clientUuid,
        fingerprint: this.fingerprint,
        platform: this.detectPlatform(),
        latitude: Number(latitude.toFixed(6)),
        longitude: Number(longitude.toFixed(6)),
        accuracy: accuracy ? Number(accuracy.toFixed(1)) : 0,
        speed: speed ? Number((speed * 3.6).toFixed(1)) : 0, // convert m/s to km/h
        heading: heading ? Math.round(heading) : 0,
        timestamp
      };

      // Persist in localStorage (fast, zero cookie serialization overhead)
      setStoredValue(STORAGE_KEYS.LAST_POSITION, JSON.stringify(this.lastPosition));

      // Always update local device display smoothly in real-time
      this.updateTelemetryDisplay(this.lastPosition);
      this.updateUIState('active');

      // Throttle database footprint transmissions to every 2 minutes (send first fix immediately or on catch-up unhide)
      const shouldSend = this.forceImmediateSync ||
                         (this.lastTelemetrySendTime === 0) ||
                         ((now - this.lastTelemetrySendTime) >= TELEMETRY_INTERVAL_MS);
      if (shouldSend) {
        this.forceImmediateSync = false;
        this.sendTelemetry(this.lastPosition);
      }
    }

    handlePositionError(error) {
      switch (error.code) {
        case error.PERMISSION_DENIED:
          this.stopTracking('Location permission denied. GPS tracking stopped.');
          break;
        case error.POSITION_UNAVAILABLE:
          this.stopTracking('GPS turned off / unavailable on mobile. Device Offline.');
          break;
        case error.TIMEOUT:
          this.networkStatus.textContent = 'GPS acquisition timed out. Retrying satellite fix...';
          break;
        default:
          this.networkStatus.textContent = 'GPS signal lost. Checking sensors...';
          break;
      }
    }

    updateTelemetryDisplay(pos) {
      if (!pos) return;
      if (this.statLat && pos.latitude !== undefined) this.statLat.textContent = `${pos.latitude}°`;
      if (this.statLng && pos.longitude !== undefined) this.statLng.textContent = `${pos.longitude}°`;

      // GPS Accuracy formatting with color rating
      if (this.statAccuracy && pos.accuracy !== undefined) {
        const acc = pos.accuracy;
        this.statAccuracy.textContent = `±${acc} m`;
        this.statAccuracy.className = 'stat-val';
        if (acc <= 10) {
          this.statAccuracy.classList.add('acc-good');
        } else if (acc <= 25) {
          this.statAccuracy.classList.add('acc-med');
        } else {
          this.statAccuracy.classList.add('acc-poor');
        }
      }

      // Speed & Heading
      if (this.statSpeed && pos.speed !== undefined) {
        const speedStr = `${pos.speed} km/h`;
        const headingStr = pos.heading ? ` (${pos.heading}°)` : '';
        this.statSpeed.textContent = speedStr + headingStr;
      }

      // Trigger live PiP canvas HUD redraw ONLY if PiP is currently open
      if (this.pipTracker && this.pipTracker.isPipActive) {
        this.pipTracker.renderFrame();
      }
    }

    async sendTelemetry(data) {
      if (!navigator.onLine) {
        this.bufferLocation(data);
        return;
      }

      try {
        this.lastTelemetrySendTime = Date.now();
        const res = await fetch(API.TELEMETRY, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {})
          },
          body: JSON.stringify(data)
        });

        if (res.ok) {
          const body = await res.json();
          this.lastSyncTime = Date.now();
          setStoredValue(STORAGE_KEYS.LAST_SYNC_TIME, String(this.lastSyncTime));

          // Sync returned device_id and device_name if backend updated or assigned them
          if (body.device_id && body.device_id !== this.deviceId) {
            this.deviceId = body.device_id;
            setStoredValue(STORAGE_KEYS.DEVICE_ID, this.deviceId);
            if (this.deviceBadge) this.deviceBadge.textContent = this.deviceId;
          }
          if (body.device_name && body.device_name !== this.deviceName) {
            this.deviceName = body.device_name;
            setStoredValue(STORAGE_KEYS.DEVICE_NAME, this.deviceName);
            if (this.userDisplayName) this.userDisplayName.textContent = this.deviceName;
          }

          // If outside geofence: track outside the fence, mark flag, do NOT pause or go offline!
          const isOutside = Boolean(body.outside_fence || body.flagged || (body.current_fence && body.current_fence.includes('Outside')));
          this.isOfflineDueToFence = false;
          this.updateUIState('active');

          if (isOutside) {
            const dist = body.distance_outside !== undefined ? body.distance_outside : 0;
            this.statGeofence.textContent = `🚩 Outside Fence (${dist}m - Flagged) • Live Footprint Shared`;
            this.statGeofence.style.color = '#ef4444';
            this.networkStatus.textContent = `Outside Fence (${dist}m) - Flagged • Live Footprints Transmitted to DB`;
          } else if (body.inside_geofences && body.inside_geofences.length > 0) {
            const fenceNames = body.inside_geofences.map(f => f.name).join(', ');
            this.statGeofence.textContent = `🟢 Inside "${fenceNames}"`;
            this.statGeofence.style.color = '#10b981';
            this.networkStatus.textContent = 'Active Always • Transmitting Footprints (Every 2 min)';
          } else {
            this.statGeofence.textContent = 'No Active Geofences';
            this.statGeofence.style.color = '#94a3b8';
            this.networkStatus.textContent = 'Active Always • Transmitting Footprints (Every 2 min)';
          }

          if (this.statGeofence) {
            setStoredValue(STORAGE_KEYS.LAST_GEOFENCE, this.statGeofence.textContent);
          }

          // Trigger tactile vibration if fence boundary crossed
          if (body.events && body.events.length > 0) {
            if ('vibrate' in navigator) {
              navigator.vibrate([200, 100, 200]);
            }
          }

          // Flush any buffered offline records
          if (this.offlineQueue.length > 0) {
            this.flushOfflineQueue();
          }
        } else {
          this.bufferLocation(data);
        }
      } catch (err) {
        this.bufferLocation(data);
      }
    }

    bufferLocation(data) {
      if (this.offlineQueue.length >= 20) {
        this.offlineQueue.shift(); // Keep maximum 20 recent fixes
      }
      this.offlineQueue.push(data);
      this.networkStatus.textContent = `Network buffering (${this.offlineQueue.length} queued)`;
    }

    async flushOfflineQueue() {
      if (this.isSending || this.offlineQueue.length === 0) return;
      this.isSending = true;

      while (this.offlineQueue.length > 0) {
        const item = this.offlineQueue[0];
        try {
          const res = await fetch(API.TELEMETRY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item)
          });
          if (res.ok) {
            this.offlineQueue.shift();
          } else {
            break;
          }
        } catch (e) {
          break;
        }
      }
      this.isSending = false;
      if (this.offlineQueue.length === 0 && !this.isOfflineDueToFence) {
        this.networkStatus.textContent = 'Active Always • Transmitting Footprints (Every 2 min)';
      }
    }

    updateSyncElapsed() {
      if (this.statLastSync) {
        if (!this.lastSyncTime) {
          this.statLastSync.textContent = 'Never';
        } else {
          const sec = Math.floor((Date.now() - this.lastSyncTime) / 1000);
          if (sec < 2) {
            this.statLastSync.textContent = 'Just now';
          } else if (sec < 60) {
            this.statLastSync.textContent = `${sec}s ago`;
          } else {
            const min = Math.floor(sec / 60);
            this.statLastSync.textContent = `${min}m ${sec % 60}s ago`;
          }
        }
      }

      // Update 2-minute database countdown
      if (this.statSyncCountdown) {
        if (!this.isTracking) {
          this.statSyncCountdown.textContent = 'Next upload: Standby';
          this.statSyncCountdown.style.color = '#38bdf8';
        } else if (this.lastTelemetrySendTime === 0) {
          this.statSyncCountdown.textContent = 'Next upload: On GPS fix';
          this.statSyncCountdown.style.color = '#38bdf8';
        } else {
          const elapsed = Date.now() - this.lastTelemetrySendTime;
          const remaining = Math.max(0, TELEMETRY_INTERVAL_MS - elapsed);
          const sec = Math.ceil(remaining / 1000);
          const min = Math.floor(sec / 60);
          const remSec = sec % 60;
          const timeStr = min > 0 ? `${min}m ${remSec}s` : `${remSec}s`;
          this.statSyncCountdown.textContent = `Next upload: in ${timeStr}`;
          this.statSyncCountdown.style.color = '#38bdf8';
        }
      }
    }

    updateUIState(state) {
      if (this.bgBadge) {
        this.bgBadge.style.display = (state === 'active' || state === 'seeking') ? 'inline-block' : 'none';
      }

      if (state === 'active') {
        this.statusPulse.className = 'pulse-dot active';
        this.statusLabel.textContent = 'Live Tracking Active';
        this.btnToggleTrack.className = 'btn-track active';
        this.btnTrackText.textContent = 'Stop GPS Tracking';
        this.btnTrackIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"></rect>';
      } else if (state === 'seeking') {
        this.statusPulse.className = 'pulse-dot seeking';
        this.statusLabel.textContent = 'Requesting GPS Location...';
        this.btnToggleTrack.className = 'btn-track loading';
        this.btnTrackText.textContent = 'Connecting GPS...';
      } else {
        this.statusPulse.className = 'pulse-dot offline';
        this.statusLabel.textContent = 'Tracking Stopped (Offline)';
        this.btnToggleTrack.className = 'btn-track';
        this.btnTrackText.textContent = 'Start GPS Tracking';
        this.btnTrackIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      }
    }
  }

  // Auto-initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    window.userTracker = new UserTracker();
  });
})();
