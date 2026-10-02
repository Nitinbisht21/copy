/**
 * Admin Panel - Real Multi-Device Tracking Engine & History Manager
 * Interacts with Leaflet map, polls GET /api/devices, renders live multi-device markers,
 * and plots historical GPS movement trails.
 */

(function () {
  'use strict';

  class AdminDeviceManager {
    constructor() {
      this.devices = [];
      this.deviceMarkers = new Map();
      this.accuracyCircles = new Map();
      this.historyPolyline = null;
      this.historyMarkers = [];
      this.activeHistoryDeviceId = null;
      this.pollInterval = null;
      this.hasAutoCentered = false;

      this.initLayersWhenMapReady();
    }

    initLayersWhenMapReady() {
      const checkMap = setInterval(() => {
        const mgr = window.mapManager || (window.geofenceApp && window.geofenceApp.mapManager);
        if (mgr && mgr.map) {
          clearInterval(checkMap);
          this.map = mgr.map;
          this.realDevicesLayer = L.layerGroup().addTo(this.map);
          this.historyLayer = L.layerGroup().addTo(this.map);

          this.initUI();
          this.fetchDevices();
          this.startPolling();
          console.log('[AdminDeviceManager] Successfully connected to Leaflet map and initialized real GPS fleet tracking.');
        }
      }, 300);
    }

    initUI() {
      this.deviceListContainer = document.getElementById('admin-device-list');
      this.deviceCountBadge = document.getElementById('device-count-badge');
      this.btnRefreshDevices = document.getElementById('btn-refresh-devices');
      this.btnConnectPhoneModal = document.getElementById('btn-connect-phone-modal');
      this.connectPhoneModal = document.getElementById('connect-phone-modal');
      this.btnCloseConnectModal = document.getElementById('btn-close-connect-modal');
      this.qrTrackerLink = document.getElementById('qr-tracker-link');
      this.btnCopyTrackerLink = document.getElementById('btn-copy-tracker-link');

      // History controls
      this.historyPanel = document.getElementById('device-history-panel');
      this.historyTitle = document.getElementById('history-device-title');
      this.historyCount = document.getElementById('history-point-count');
      this.btnClearHistoryTrail = document.getElementById('btn-clear-history-trail');

      if (this.btnRefreshDevices) {
        this.btnRefreshDevices.addEventListener('click', () => this.fetchDevices(true));
      }

      if (this.btnConnectPhoneModal) {
        this.btnConnectPhoneModal.addEventListener('click', () => this.openConnectModal());
      }

      if (this.btnCloseConnectModal) {
        this.btnCloseConnectModal.addEventListener('click', () => this.closeConnectModal());
      }

      if (this.btnCopyTrackerLink) {
        this.btnCopyTrackerLink.addEventListener('click', () => this.copyTrackerUrl());
      }

      if (this.btnClearHistoryTrail) {
        this.btnClearHistoryTrail.addEventListener('click', () => this.clearHistoryTrail());
      }
    }

    startPolling() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      // Poll every 3 seconds for live fleet telemetry
      this.pollInterval = setInterval(() => this.fetchDevices(false), 3000);
    }

    async fetchDevices(showToastNotification = false) {
      try {
        const res = await fetch('/api/devices');
        if (res.ok) {
          this.devices = await res.json();
          this.renderDeviceList();
          this.updateMapMarkers();

          // Auto-center map on active mobile phone when first discovered
          if (!this.hasAutoCentered && this.devices.length > 0 && this.map) {
            const firstActive = this.devices.find(d => d.last_location && typeof d.last_location.latitude === 'number' && typeof d.last_location.longitude === 'number');
            if (firstActive) {
              this.hasAutoCentered = true;
              this.map.setView([firstActive.last_location.latitude, firstActive.last_location.longitude], 16);
            }
          }

          if (showToastNotification && window.uiController) {
            window.uiController.showToast(`Updated ${this.devices.length} registered devices`, 'info');
          }
        }
      } catch (err) {
        console.warn('Could not fetch devices:', err);
      }
    }

    renderDeviceList() {
      if (!this.deviceListContainer) return;

      const onlineCount = this.devices.filter(d => d.status === 'online').length;
      if (this.deviceCountBadge) {
        this.deviceCountBadge.textContent = `${onlineCount}/${this.devices.length}`;
      }

      if (this.devices.length === 0) {
        this.deviceListContainer.innerHTML = `
          <div class="empty-hint" style="font-size: 0.74rem; text-align: center; padding: 1rem 0.5rem;">
            No devices connected yet.<br>
            <button type="button" class="btn-connect-sm" onclick="window.adminDeviceManager.openConnectModal()" style="margin-top: 0.5rem;">
              + Connect Phone
            </button>
          </div>
        `;
        return;
      }

      this.deviceListContainer.innerHTML = this.devices
        .map((device) => {
          const statusClass = device.status || 'offline';
          const isOutsideForced = Boolean(device.is_offline_forced || device.offline_reason === 'outside_fence_100m');
          let statusLabel = statusClass.toUpperCase();
          if (isOutsideForced) {
            statusLabel = 'OFFLINE (>100m)';
          }
          const lastLoc = device.last_location;
          const coordsStr = lastLoc ? `${lastLoc.latitude.toFixed(4)}°, ${lastLoc.longitude.toFixed(4)}°` : 'No GPS Fix';
          const accStr = (lastLoc && lastLoc.accuracy) ? `±${Math.round(lastLoc.accuracy)}m` : '';
          let fenceStr = isOutsideForced
            ? `🚫 Outside (${Math.round(device.distance_outside || 100)}m - Paused)`
            : (device.current_fence && device.current_fence !== 'No Active Fences' ? `🟢 ${device.current_fence}` : null);

          // Dynamic client-side evaluation against active map geofences
          if (!fenceStr && lastLoc && window.geofenceApp && window.geofenceApp.store) {
            const activeFences = window.geofenceApp.store.getActiveGeofences();
            for (const f of activeFences) {
              if (f.type === 'circle' && f.coordinates && f.radius) {
                const d = this.calculateDistance(lastLoc.latitude, lastLoc.longitude, f.coordinates.lat, f.coordinates.lng);
                if (d <= f.radius) {
                  fenceStr = `🟢 Inside "${f.name}"`;
                  break;
                }
              }
            }
          }
          if (!fenceStr) {
            fenceStr = device.current_fence ? `🟢 ${device.current_fence}` : 'Outside Fences';
          }
          const isHistoryActive = this.activeHistoryDeviceId === device.device_id;

          return `
            <div class="device-card-item ${statusClass}" data-device-id="${device.device_id}">
              <div class="device-header-row">
                <div class="device-identity">
                  <span class="status-indicator-dot ${statusClass}"></span>
                  <span class="device-name-text">${this.escape(device.device_name)}</span>
                  <span class="device-pill-id">${this.escape(device.device_id)}</span>
                </div>
                <span class="device-status-badge ${statusClass}">${statusLabel}</span>
              </div>

              <div class="device-meta-row">
                <span class="device-loc-coords">${coordsStr} ${accStr ? `<small>(${accStr})</small>` : ''}</span>
                <span class="device-fence-status" title="Current Geofence Zone">${fenceStr}</span>
              </div>

              <div class="device-actions-row">
                <button type="button" class="btn-device-action" onclick="window.adminDeviceManager.centerOnDevice('${device.device_id}')" title="Zoom to device on map">
                  📍 Locate
                </button>
                <button type="button" class="btn-device-action ${isHistoryActive ? 'active' : ''}" onclick="window.adminDeviceManager.toggleDeviceHistory('${device.device_id}')" title="View historical path trail">
                  📈 ${isHistoryActive ? 'Hide Path' : 'Trail'}
                </button>
                <button type="button" class="btn-device-action danger" onclick="window.adminDeviceManager.revokeDevicePrompt('${device.device_id}')" title="Revoke device access">
                  ✕ Revoke
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    }

    updateMapMarkers() {
      if (!this.map || !this.realDevicesLayer) return;

      const seenIds = new Set();

      this.devices.forEach((device) => {
        const loc = device.last_location;
        if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return;

        seenIds.add(device.device_id);
        const latlng = [loc.latitude, loc.longitude];
        const status = device.status || 'offline';
        const isOutsideForced = Boolean(device.is_offline_forced || device.offline_reason === 'outside_fence_100m');
        const color = isOutsideForced ? '#ef4444' : status === 'online' ? '#10b981' : status === 'inactive' ? '#f59e0b' : '#94a3b8';

        // Check if marker exists
        let marker = this.deviceMarkers.get(device.device_id);
        let accCircle = this.accuracyCircles.get(device.device_id);

        if (!marker) {
          const icon = L.divIcon({
            className: `real-device-map-marker ${status}`,
            html: `
              <div class="device-marker-pulse" style="background:${color}; box-shadow:0 0 10px ${color}"></div>
              <div class="device-marker-core" style="background:${color}"></div>
              <div class="device-marker-label">${this.escape(device.device_name)}</div>
            `,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
          });

          marker = L.marker(latlng, { icon, zIndexOffset: 800 }).addTo(this.realDevicesLayer);
          marker.bindPopup(() => this.generateDevicePopup(device));
          this.deviceMarkers.set(device.device_id, marker);

          // Accuracy radius circle if available
          if (loc.accuracy && loc.accuracy > 0 && loc.accuracy < 100) {
            accCircle = L.circle(latlng, {
              radius: loc.accuracy,
              color: color,
              weight: 1,
              opacity: 0.4,
              fillColor: color,
              fillOpacity: 0.1
            }).addTo(this.realDevicesLayer);
            this.accuracyCircles.set(device.device_id, accCircle);
          }
        } else {
          // Smoothly update location
          marker.setLatLng(latlng);
          marker.setIcon(
            L.divIcon({
              className: `real-device-map-marker ${status}`,
              html: `
                <div class="device-marker-pulse" style="background:${color}; box-shadow:0 0 10px ${color}"></div>
                <div class="device-marker-core" style="background:${color}"></div>
                <div class="device-marker-label">${this.escape(device.device_name)}</div>
              `,
              iconSize: [28, 28],
              iconAnchor: [14, 14]
            })
          );
          if (marker.isPopupOpen()) {
            marker.setPopupContent(this.generateDevicePopup(device));
          }

          if (accCircle) {
            accCircle.setLatLng(latlng);
            if (loc.accuracy) accCircle.setRadius(loc.accuracy);
            accCircle.setStyle({ color: color, fillColor: color });
          }
        }
      });

      // Remove deleted markers
      for (const [id, marker] of this.deviceMarkers.entries()) {
        if (!seenIds.has(id)) {
          this.realDevicesLayer.removeLayer(marker);
          this.deviceMarkers.delete(id);
          const circle = this.accuracyCircles.get(id);
          if (circle) {
            this.realDevicesLayer.removeLayer(circle);
            this.accuracyCircles.delete(id);
          }
        }
      }
    }

    generateDevicePopup(device) {
      const loc = device.last_location || {};
      const statusClass = device.status || 'offline';
      const isOutsideForced = Boolean(device.is_offline_forced || device.offline_reason === 'outside_fence_100m');
      const statusText = isOutsideForced
        ? `OFFLINE (${Math.round(device.distance_outside || 100)}m Outside - Paused)`
        : (device.status || 'offline').toUpperCase();
      const lastSeenStr = device.last_seen ? new Date(device.last_seen).toLocaleTimeString() : 'Unknown';

      return `
        <div class="device-popup-card">
          <div class="popup-title-row">
            <span class="status-indicator-dot ${statusClass}"></span>
            <strong style="font-size:0.95rem;">${this.escape(device.device_name)}</strong>
          </div>
          <div class="popup-id-row">
            <code>${this.escape(device.device_id)}</code> • <span class="badge-${statusClass}">${statusText}</span>
          </div>
          <div class="popup-grid">
            <div class="popup-grid-item">
              <span class="popup-label">Latitude</span>
              <span class="popup-val">${loc.latitude ? loc.latitude.toFixed(6) : '—'}°</span>
            </div>
            <div class="popup-grid-item">
              <span class="popup-label">Longitude</span>
              <span class="popup-val">${loc.longitude ? loc.longitude.toFixed(6) : '—'}°</span>
            </div>
            <div class="popup-grid-item">
              <span class="popup-label">Accuracy</span>
              <span class="popup-val">${loc.accuracy ? `±${loc.accuracy} m` : '—'}</span>
            </div>
            <div class="popup-grid-item">
              <span class="popup-label">Speed</span>
              <span class="popup-val">${loc.speed ? `${loc.speed} km/h` : '0 km/h'}</span>
            </div>
          </div>
          <div class="popup-fence-row">
            <span class="popup-label">Zone Status:</span>
            <span style="color:#10b981; font-weight:600;">${device.current_fence || 'Outside Geofences'}</span>
          </div>
          <div class="popup-time">Last update: ${lastSeenStr}</div>
        </div>
      `;
    }

    centerOnDevice(deviceId) {
      const device = this.devices.find(d => d.device_id === deviceId);
      if (device && device.last_location) {
        const { latitude, longitude } = device.last_location;
        this.map.flyTo([latitude, longitude], 17, { duration: 1.2 });
        const marker = this.deviceMarkers.get(deviceId);
        if (marker) {
          setTimeout(() => marker.openPopup(), 1300);
        }
      } else {
        if (window.uiController) {
          window.uiController.showToast(`No GPS fix for ${deviceId} yet. Start tracking on phone.`, 'warning');
        }
      }
    }

    async toggleDeviceHistory(deviceId) {
      if (this.activeHistoryDeviceId === deviceId) {
        this.clearHistoryTrail();
        return;
      }

      this.clearHistoryTrail();
      this.activeHistoryDeviceId = deviceId;
      const device = this.devices.find(d => d.device_id === deviceId);
      const name = device ? device.device_name : deviceId;

      try {
        const res = await fetch(`/api/devices/${deviceId}/history?limit=200`);
        if (res.ok) {
          const history = await res.json();
          if (!Array.isArray(history) || history.length === 0) {
            if (window.uiController) window.uiController.showToast(`No previous path recorded for ${name}`, 'info');
            this.clearHistoryTrail();
            return;
          }

          const latlngs = history.map(h => [h.latitude, h.longitude]);

          // Draw polyline path
          this.historyPolyline = L.polyline(latlngs, {
            color: '#38bdf8',
            weight: 4,
            opacity: 0.85,
            dashArray: '8, 8',
            lineJoin: 'round'
          }).addTo(this.historyLayer);

          // Add Start & End pins
          const startPt = latlngs[0];
          const endPt = latlngs[latlngs.length - 1];

          const startPin = L.circleMarker(startPt, {
            radius: 6,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 1
          }).bindPopup(`<b>Start Location</b><br>${new Date(history[0].timestamp).toLocaleTimeString()}`);

          const endPin = L.circleMarker(endPt, {
            radius: 6,
            color: '#ef4444',
            fillColor: '#ef4444',
            fillOpacity: 1
          }).bindPopup(`<b>Most Recent Location</b><br>${new Date(history[history.length - 1].timestamp).toLocaleTimeString()}`);

          startPin.addTo(this.historyLayer);
          endPin.addTo(this.historyLayer);
          this.historyMarkers.push(startPin, endPin);

          // Show History HUD banner
          if (this.historyPanel) {
            this.historyPanel.classList.remove('hidden');
            if (this.historyTitle) this.historyTitle.textContent = name;
            if (this.historyCount) this.historyCount.textContent = `${history.length} waypoints`;
          }

          this.map.fitBounds(this.historyPolyline.getBounds(), { padding: [50, 50] });
          this.renderDeviceList();

          if (window.uiController) {
            window.uiController.showToast(`Showing ${history.length} location waypoints for ${name}`, 'success');
          }
        }
      } catch (err) {
        console.warn('Failed to load device history:', err);
      }
    }

    clearHistoryTrail() {
      this.activeHistoryDeviceId = null;
      if (this.historyPolyline) {
        this.historyLayer.removeLayer(this.historyPolyline);
        this.historyPolyline = null;
      }
      this.historyMarkers.forEach(m => this.historyLayer.removeLayer(m));
      this.historyMarkers = [];
      if (this.historyPanel) this.historyPanel.classList.add('hidden');
      this.renderDeviceList();
    }

    async revokeDevicePrompt(deviceId) {
      if (!confirm(`Are you sure you want to revoke device "${deviceId}"? It will no longer be allowed to send location updates.`)) {
        return;
      }

      try {
        const res = await fetch(`/api/devices/${deviceId}/revoke`, { method: 'POST' });
        if (res.ok) {
          if (window.uiController) window.uiController.showToast(`Device ${deviceId} revoked`, 'info');
          this.fetchDevices();
        }
      } catch (err) {
        console.warn('Revoke error:', err);
      }
    }

    async openConnectModal() {
      let trackUrl = `${window.location.origin}/track`;

      try {
        const netRes = await fetch('/api/network/info');
        if (netRes.ok) {
          const netData = await netRes.json();
          if (netData.track_url) {
            trackUrl = netData.track_url;
          }
        }
      } catch (e) {
        // Fallback to origin
      }

      if (this.qrTrackerLink) this.qrTrackerLink.value = trackUrl;
      const btnOpen = document.getElementById('btn-open-tracker-tab');
      if (btnOpen) btnOpen.href = trackUrl;

      if (this.connectPhoneModal) this.connectPhoneModal.classList.remove('hidden');
    }

    closeConnectModal() {
      if (this.connectPhoneModal) this.connectPhoneModal.classList.add('hidden');
    }

    copyTrackerUrl() {
      const url = this.qrTrackerLink ? this.qrTrackerLink.value : `${window.location.origin}/track`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          if (window.uiController) window.uiController.showToast('Copied tracking URL to clipboard!', 'success');
        });
      } else {
        prompt('Copy this tracking URL on your phone:', url);
      }
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
      const R = 6371008.8;
      const toRad = deg => (deg * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    escape(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  }

  // Expose globally
  window.adminDeviceManager = new AdminDeviceManager();
})();
