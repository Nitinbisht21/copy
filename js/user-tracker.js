/**
 * Mobile GPS Tracker Client Engine
 * Transmits real-time HTML5 Geolocation API telemetry to the Flask backend
 * Supports Screen Wake Lock, GPS accuracy estimation, and offline buffering.
 */

(function () {
  'use strict';

  // Constants & Storage Keys
  const STORAGE_KEYS = {
    DEVICE_ID: 'vf_device_id',
    DEVICE_NAME: 'vf_device_name',
    AUTH_TOKEN: 'vf_auth_token',
    USER_ID: 'vf_user_id'
  };

  const API = {
    REGISTER_DEVICE: '/api/devices/register',
    TELEMETRY: '/api/telemetry',
    DEVICE: (id) => `/api/devices/${id}`
  };

  const TELEMETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes (120,000 ms) data footprint interval

  class UserTracker {
    constructor() {
      this.deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID) || null;
      this.deviceName = localStorage.getItem(STORAGE_KEYS.DEVICE_NAME) || 'Mobile Phone';
      this.token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN) || null;
      this.userId = localStorage.getItem(STORAGE_KEYS.USER_ID) || 'anon_user';

      this.isTracking = false;
      this.watchId = null;
      this.wakeLock = null;
      this.lastPosition = null;
      this.lastSyncTime = null;
      this.lastTelemetrySendTime = 0;
      this.isOfflineDueToFence = false;
      this.syncTimer = null;
      this.offlineQueue = [];
      this.isSending = false;

      this.initElements();
      this.bindEvents();
      this.initDevice();
    }

    initElements() {
      this.statusPulse = document.getElementById('status-pulse');
      this.statusLabel = document.getElementById('status-label');
      this.networkStatus = document.getElementById('network-status');
      this.deviceBadge = document.getElementById('device-badge');
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
    }

    bindEvents() {
      this.btnToggleTrack.addEventListener('click', () => {
        if (this.isTracking) {
          this.stopTracking();
        } else {
          this.startTracking();
        }
      });

      this.btnUserProfile.addEventListener('click', () => {
        this.openDeviceModal();
      });

      this.btnCloseDeviceModal.addEventListener('click', () => {
        this.closeDeviceModal();
      });

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

      // Re-acquire Screen Wake Lock when browser tab becomes visible again
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && this.isTracking) {
          await this.requestWakeLock();
        }
      });

      // Update "Last updated X seconds ago" counter every second
      setInterval(() => this.updateSyncElapsed(), 1000);
    }

    detectPlatform() {
      const ua = navigator.userAgent || '';
      if (/android/i.test(ua)) return 'android';
      if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
      return 'browser';
    }

    async initDevice() {
      const defaultName = this.deviceName || `Device ${Math.floor(100 + Math.random() * 900)}`;
      await this.registerDeviceOnBackend(defaultName, this.deviceId);
      this.deviceBadge.textContent = this.deviceId;
      this.userDisplayName.textContent = this.deviceName;
      this.inputDeviceName.value = this.deviceName;
      this.inputDeviceId.value = this.deviceId;
    }

    async registerDeviceOnBackend(name, customId = null) {
      try {
        const payload = {
          device_name: name,
          platform: this.detectPlatform(),
          user_id: this.userId,
          device_id: customId || this.deviceId
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
          localStorage.setItem(STORAGE_KEYS.DEVICE_ID, this.deviceId);
          localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, this.deviceName);

          this.deviceBadge.textContent = this.deviceId;
          this.userDisplayName.textContent = this.deviceName;
          this.closeDeviceModal();
          this.networkStatus.textContent = 'Device Connected & Ready';
        } else {
          const err = await res.json();
          alert(`Device registration notice: ${err.error || 'Check server connection'}`);
        }
      } catch (err) {
        // In case server is offline, use local id
        if (!this.deviceId) {
          this.deviceId = customId || `DEV_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
          this.deviceName = name;
          localStorage.setItem(STORAGE_KEYS.DEVICE_ID, this.deviceId);
          localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, this.deviceName);
          this.deviceBadge.textContent = this.deviceId;
          this.userDisplayName.textContent = this.deviceName;
        }
        this.closeDeviceModal();
      }
    }

    openDeviceModal() {
      this.inputDeviceName.value = this.deviceName;
      this.inputDeviceId.value = this.deviceId || '';
      this.deviceModal.classList.remove('hidden');
    }

    closeDeviceModal() {
      this.deviceModal.classList.add('hidden');
    }

    // =========================================================================
    // GPS WATCHER & SCREEN WAKE LOCK
    // =========================================================================

    async startTracking() {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your mobile browser.');
        return;
      }

      this.isTracking = true;
      this.lastTelemetrySendTime = 0;
      this.isOfflineDueToFence = false;
      this.updateUIState('seeking');
      this.networkStatus.textContent = 'Acquiring GPS Fix...';

      // Request Screen Wake Lock so screen does not lock and throttle GPS
      await this.requestWakeLock();

      const options = {
        enableHighAccuracy: true,
        maximumAge: 0, // Force fresh real-time satellite reading, bypass stale browser cache
        timeout: 20000
      };

      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.handlePosition(pos),
        (err) => this.handlePositionError(err),
        options
      );
    }

    stopTracking() {
      this.isTracking = false;
      this.lastTelemetrySendTime = 0;
      this.isOfflineDueToFence = false;
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.releaseWakeLock();
      this.updateUIState('stopped');
      this.networkStatus.textContent = 'Tracking Stopped';
      if (this.statSyncCountdown) {
        this.statSyncCountdown.textContent = 'Next upload: Standby';
        this.statSyncCountdown.style.color = '#38bdf8';
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

    handlePosition(position) {
      if (!this.isTracking) return;

      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      const timestamp = new Date(position.timestamp || Date.now()).toISOString();

      this.lastPosition = {
        device_id: this.deviceId,
        device_name: this.deviceName,
        latitude: Number(latitude.toFixed(6)),
        longitude: Number(longitude.toFixed(6)),
        accuracy: accuracy ? Number(accuracy.toFixed(1)) : 0,
        speed: speed ? Number((speed * 3.6).toFixed(1)) : 0, // convert m/s to km/h
        heading: heading ? Math.round(heading) : 0,
        timestamp
      };

      // Always update local device display smoothly in real-time
      this.updateTelemetryDisplay(this.lastPosition);
      if (!this.isOfflineDueToFence) {
        this.updateUIState('active');
      }

      // Throttle database footprint transmissions to every 2 minutes (send first fix immediately)
      const now = Date.now();
      const shouldSend = (this.lastTelemetrySendTime === 0) || ((now - this.lastTelemetrySendTime) >= TELEMETRY_INTERVAL_MS);
      if (shouldSend) {
        this.sendTelemetry(this.lastPosition);
      }
    }

    handlePositionError(error) {
      let msg = 'GPS error occurred.';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          msg = 'Location permission denied. Please allow location access in your browser settings.';
          this.stopTracking();
          break;
        case error.POSITION_UNAVAILABLE:
          msg = 'GPS signal unavailable. Move to an area with clear sky view.';
          break;
        case error.TIMEOUT:
          msg = 'GPS acquisition timed out. Retrying...';
          break;
      }
      this.networkStatus.textContent = msg;
    }

    updateTelemetryDisplay(pos) {
      this.statLat.textContent = `${pos.latitude}°`;
      this.statLng.textContent = `${pos.longitude}°`;

      // GPS Accuracy formatting with color rating
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

      // Speed & Heading
      const speedStr = `${pos.speed} km/h`;
      const headingStr = pos.heading ? ` (${pos.heading}°)` : '';
      this.statSpeed.textContent = speedStr + headingStr;
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

          // Handle 100m outside fence cutoff: device set to offline and tracking paused
          if (body.status === 'offline' || body.tracking_active === false) {
            this.isOfflineDueToFence = true;
            this.updateUIState('fence-offline');
            const dist = body.distance_outside !== undefined ? body.distance_outside : '>100';
            this.statGeofence.textContent = `🔴 Outside Fence (${dist}m) - OFFLINE (No Footprint Shared to DB)`;
            this.statGeofence.style.color = '#ef4444';
            this.networkStatus.textContent = 'Outside Fence (>100m) - Offline • No Footprint Shared to DB';
          } else {
            this.isOfflineDueToFence = false;
            this.updateUIState('active');
            if (body.inside_geofences && body.inside_geofences.length > 0) {
              const fenceNames = body.inside_geofences.map(f => f.name).join(', ');
              this.statGeofence.textContent = `🟢 Inside "${fenceNames}"`;
              this.statGeofence.style.color = '#10b981';
            } else {
              const dist = body.distance_outside !== undefined ? body.distance_outside : '<100';
              this.statGeofence.textContent = `🟡 Near Fence (${dist}m - Within 100m Buffer)`;
              this.statGeofence.style.color = '#f59e0b';
            }
            this.networkStatus.textContent = 'Active Always • Transmitting Footprints (Every 2 min)';
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
        } else if (this.isOfflineDueToFence) {
          this.statSyncCountdown.textContent = 'Next upload: Paused (>100m outside)';
          this.statSyncCountdown.style.color = '#ef4444';
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
      if (state === 'fence-offline') {
        this.statusPulse.className = 'pulse-dot offline';
        this.statusLabel.textContent = 'Device Offline (>100m Outside Fence)';
        this.btnToggleTrack.className = 'btn-track active';
        this.btnTrackText.textContent = 'Stop GPS Tracking';
        this.btnTrackIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"></rect>';
      } else if (state === 'active') {
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
        this.statusPulse.className = 'pulse-dot';
        this.statusLabel.textContent = 'Tracking Stopped';
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
