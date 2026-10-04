/**
 * Admin Panel - Real Multi-Device Tracking Engine & History Manager
 * Interacts with Leaflet map, polls GET /api/devices, renders live multi-device markers,
 * enforces 1-device = 1-location deduplication, and plots historical GPS movement trails.
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
          console.log('[AdminDeviceManager] Connected to map with deduplicated fleet tracking.');
        }
      }, 300);
    }

    initUI() {
      this.deviceListContainer = document.getElementById('admin-device-list');
      this.deviceCountBadge = document.getElementById('device-count-badge');
      this.btnRefreshDevices = document.getElementById('btn-refresh-devices');
      this.btnCleanDuplicates = document.getElementById('btn-clean-duplicates');
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

      if (this.btnCleanDuplicates) {
        this.btnCleanDuplicates.addEventListener('click', () => this.purgeDuplicates());
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

    // Client-side deduplication safeguard to guarantee 1 physical device = 1 marker & 1 card
    // Client-side deduplication safeguard to guarantee 1 physical device client = 1 marker & 1 card
    deduplicateDevices(deviceList) {
      if (!Array.isArray(deviceList) || deviceList.length === 0) return [];

      const map = new Map();
      for (const dev of deviceList) {
        const cu = dev.client_uuid;
        const did = dev.device_id;
        // Group strictly by persistent client_uuid if present, else by device_id
        const key = (cu && cu.length >= 6) ? `cu_${cu}` : `id_${did}`;

        if (!map.has(key)) {
          map.set(key, dev);
        } else {
          // If duplicate records exist for the same client installation, keep the one with newest last_seen
          const existing = map.get(key);
          const exTs = existing.last_seen || existing.updated_at || '';
          const curTs = dev.last_seen || dev.updated_at || '';
          if (curTs >= exTs) {
            map.set(key, dev);
          }
        }
      }

      // Return all distinct devices; NEVER discard physical devices standing close together or sharing an IP
      return Array.from(map.values());
    }

    async fetchDevices(showToastNotification = false) {
      try {
        const res = await fetch('/api/devices');
        if (res.ok) {
          const rawDevices = await res.json();
          this.devices = this.deduplicateDevices(rawDevices);
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
            window.uiController.showToast(`Updated ${this.devices.length} unique device(s)`, 'info');
          }
        }
      } catch (err) {
        console.warn('Could not fetch devices:', err);
      }
    }

    async purgeDuplicates() {
      try {
        const res = await fetch('/api/devices/purge-duplicates', { method: 'POST' });
        if (res.ok) {
          if (window.uiController) {
            window.uiController.showToast('Cleaned duplicate device copies.', 'success');
          }
          await this.fetchDevices(false);
        }
      } catch (e) {
        console.warn('Purge error:', e);
      }
    }

    evaluateDeviceGeofence(device) {
      const status = device.status || 'offline';
      const lastLoc = device.last_location;
      const isOutside = Boolean(
        device.outside_fence ||
        device.flagged ||
        (lastLoc && (lastLoc.outside_fence || lastLoc.flagged)) ||
        (device.current_fence && device.current_fence.includes('Outside'))
      );

      if (status === 'offline') {
        if (isOutside) {
          return '⚪ Offline (Last: Outside Fence)';
        }
        return '⚪ Offline (Tracking Stopped)';
      }

      if (isOutside) {
        const dist = Math.round(device.distance_outside || (lastLoc && lastLoc.distance_outside) || 0);
        return `🚩 Outside (${dist}m - Flagged)`;
      }

      if (!lastLoc || typeof lastLoc.latitude !== 'number' || typeof lastLoc.longitude !== 'number') {
        return 'No GPS Fix';
      }

      // Check current geofences from active map store
      const store = (window.geofenceApp && window.geofenceApp.store) || window.geofenceStore;
      if (store && typeof store.getActiveGeofences === 'function') {
        const activeFences = store.getActiveGeofences();
        for (const f of activeFences) {
          if (f.type === 'circle' && f.coordinates && f.radius) {
            const cLat = Number(f.coordinates.lat);
            const cLng = Number(f.coordinates.lng);
            const d = this.calculateDistance(lastLoc.latitude, lastLoc.longitude, cLat, cLng);
            if (d <= Number(f.radius)) {
              return `🟢 Inside "${this.escape(f.name)}"`;
            }
          } else if (f.type === 'rectangle' && f.coordinates) {
            const { north, south, east, west } = f.coordinates;
            if (lastLoc.latitude <= north && lastLoc.latitude >= south && lastLoc.longitude <= east && lastLoc.longitude >= west) {
              return `🟢 Inside "${this.escape(f.name)}"`;
            }
          }
        }
      }

      if (device.current_fence && !device.current_fence.includes('No Active Fences') && !device.current_fence.includes('Outside')) {
        return `🟢 ${device.current_fence}`;
      }

      return '🚩 Outside Fences (Flagged)';
    }

    renderDeviceList() {
      if (!this.deviceListContainer) return;

      const onlineCount = this.devices.filter(d => d.status === 'online').length;
      if (this.deviceCountBadge) {
        this.deviceCountBadge.textContent = `${onlineCount}/${this.devices.length}`;
      }

      if (this.devices.length === 0) {
        if (this._lastListHash !== 'empty') {
          this._lastListHash = 'empty';
          this.deviceListContainer.innerHTML = `
            <div class="empty-hint" style="font-size: 0.74rem; text-align: center; padding: 1rem 0.5rem;">
              No devices connected yet.<br>
              <button type="button" class="btn-connect-sm" onclick="window.adminDeviceManager.openConnectModal()" style="margin-top: 0.5rem;">
                + Connect Phone
              </button>
            </div>
          `;
        }
        return;
      }

      const listHash = this.devices.map(d => `${d.device_id}_${d.status}_${(d.last_location&&d.last_location.latitude)||0}_${(d.last_location&&d.last_location.longitude)||0}_${d.device_name}_${d.current_fence}_${this.activeHistoryDeviceId === d.device_id}`).join('|');
      if (this._lastListHash === listHash) {
        return;
      }
      this._lastListHash = listHash;

      this.deviceListContainer.innerHTML = this.devices
        .map((device) => {
          const statusClass = (device.status === 'online') ? 'online' : 'offline';
          const lastLoc = device.last_location;
          const isOutside = Boolean(
            device.outside_fence ||
            device.flagged ||
            (lastLoc && (lastLoc.outside_fence || lastLoc.flagged)) ||
            (device.current_fence && device.current_fence.includes('Outside'))
          );

          let statusBadgeClass = statusClass;
          let statusLabel = statusClass.toUpperCase();
          if (statusClass === 'online' && isOutside) {
            statusBadgeClass = 'outside-flagged';
            statusLabel = '🚩 OUTSIDE (FLAGGED)';
          }

          const coordsStr = lastLoc ? `${lastLoc.latitude.toFixed(4)}°, ${lastLoc.longitude.toFixed(4)}°` : 'No GPS Fix';
          const accStr = (lastLoc && lastLoc.accuracy) ? `±${Math.round(lastLoc.accuracy)}m` : '';
          const fenceStr = this.evaluateDeviceGeofence(device);
          const isHistoryActive = this.activeHistoryDeviceId === device.device_id;

          return `
            <div class="device-card-item ${statusClass}" data-device-id="${device.device_id}">
              <div class="device-header-row">
                <div class="device-identity">
                  <span class="status-indicator-dot ${statusBadgeClass}"></span>
                  <span class="device-name-text">${this.escape(device.device_name || 'Device')}</span>
                  <span class="device-pill-id">${this.escape(device.device_id)}</span>
                </div>
                <span class="device-status-badge ${statusBadgeClass}">${statusLabel}</span>
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
                  📈 ${isHistoryActive ? 'Hide' : 'Trail'}
                </button>
                <button type="button" class="btn-device-action danger" onclick="window.adminDeviceManager.deleteDevicePrompt('${device.device_id}')" title="Delete device and history">
                  🗑 Delete
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    }

    getDeviceMarkerColor(device, index = 0) {
      const status = device.status || 'offline';
      if (status === 'offline') return '#94a3b8'; // Offline devices always grey!

      const isOutside = Boolean(
        device.outside_fence ||
        device.flagged ||
        (device.last_location && (device.last_location.outside_fence || device.last_location.flagged)) ||
        (device.current_fence && device.current_fence.includes('Outside'))
      );
      if (isOutside) return '#ef4444'; // Red flagged marker when active and outside fence!

      const FLEET_PALETTE = ['#10b981', '#3b82f6', '#8b5cf6', '#f97316', '#06b6d4', '#ec4899', '#14b8a6', '#eab308'];
      let num = device.device_number || (index + 1);
      if (!num || isNaN(num)) {
        const m = (device.device_name || '').match(/\b(\d+)\b/);
        num = m ? parseInt(m[1], 10) : (index + 1);
      }
      return FLEET_PALETTE[(num - 1) % FLEET_PALETTE.length];
    }

    updateMapMarkers() {
      if (!this.map || !this.realDevicesLayer) return;

      const seenIds = new Set();

      this.devices.forEach((device, idx) => {
        const loc = device.last_location;
        if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return;

        seenIds.add(device.device_id);
        const latlng = [loc.latitude, loc.longitude];
        const status = device.status || 'offline';
        const color = this.getDeviceMarkerColor(device, idx);

        // Check if marker exists
        let marker = this.deviceMarkers.get(device.device_id);
        let accCircle = this.accuracyCircles.get(device.device_id);

        const labelText = device.device_name || device.device_id;

        if (!marker) {
          const icon = L.divIcon({
            className: `real-device-map-marker ${status}`,
            html: `
              <div class="device-marker-pulse" style="background:${color}; box-shadow:0 0 10px ${color}"></div>
              <div class="device-marker-core" style="background:${color}"></div>
              <div class="device-marker-label">${this.escape(labelText)}</div>
            `,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
          });

          marker = L.marker(latlng, { icon, zIndexOffset: 800 }).addTo(this.realDevicesLayer);
          marker.bindPopup(() => this.generateDevicePopup(device));
          marker._vf_last_lat = loc.latitude;
          marker._vf_last_lng = loc.longitude;
          marker._vf_last_status = status;
          marker._vf_last_color = color;
          marker._vf_last_label = labelText;
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
          // Only update position if changed
          if (marker._vf_last_lat !== loc.latitude || marker._vf_last_lng !== loc.longitude) {
            marker.setLatLng(latlng);
            marker._vf_last_lat = loc.latitude;
            marker._vf_last_lng = loc.longitude;
          }

          // Only update icon if appearance changed
          if (marker._vf_last_status !== status || marker._vf_last_color !== color || marker._vf_last_label !== labelText) {
            marker._vf_last_status = status;
            marker._vf_last_color = color;
            marker._vf_last_label = labelText;
            marker.setIcon(
              L.divIcon({
                className: `real-device-map-marker ${status}`,
                html: `
                  <div class="device-marker-pulse" style="background:${color}; box-shadow:0 0 10px ${color}"></div>
                  <div class="device-marker-core" style="background:${color}"></div>
                  <div class="device-marker-label">${this.escape(labelText)}</div>
                `,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
              })
            );
          }

          if (marker.isPopupOpen()) {
            marker.setPopupContent(this.generateDevicePopup(device));
          }

          if (accCircle) {
            if (status === 'offline') {
              accCircle.setStyle({ opacity: 0, fillOpacity: 0 });
            } else {
              accCircle.setLatLng(latlng);
              if (loc.accuracy) accCircle.setRadius(loc.accuracy);
              accCircle.setStyle({ color: color, fillColor: color, opacity: 0.4, fillOpacity: 0.1 });
            }
          }
        }
      });

      // Remove deleted/pruned markers immediately
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
      const statusClass = (device.status === 'online') ? 'online' : 'offline';
      const isOutside = Boolean(
        device.outside_fence ||
        device.flagged ||
        (loc && (loc.outside_fence || loc.flagged)) ||
        (device.current_fence && device.current_fence.includes('Outside'))
      );
      let statusText = (device.status || 'offline').toUpperCase();
      let statusBadgeClass = statusClass;
      if (statusClass === 'online' && isOutside) {
        statusText = '🚩 ONLINE (OUTSIDE - FLAGGED)';
        statusBadgeClass = 'outside-flagged';
      }
      const lastSeenStr = device.last_seen ? new Date(device.last_seen).toLocaleTimeString() : 'Unknown';
      const fenceDisplay = this.evaluateDeviceGeofence(device);

      return `
        <div class="device-popup-card">
          <div class="popup-title-row">
            <span class="status-indicator-dot ${statusBadgeClass}"></span>
            <strong style="font-size:0.95rem;">${this.escape(device.device_name || 'Device')}</strong>
          </div>
          <div class="popup-id-row">
            <code>${this.escape(device.device_id)}</code> • <span class="device-status-badge ${statusBadgeClass}">${statusText}</span>
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
            <span style="color:#10b981; font-weight:600;">${fenceDisplay}</span>
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

    async deleteDevicePrompt(deviceId) {
      if (!confirm(`Permanently remove device "${deviceId}"? This removes all duplicate copies and history.`)) {
        return;
      }

      try {
        const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
        if (res.ok) {
          if (window.uiController) window.uiController.showToast(`Device ${deviceId} deleted`, 'info');
          await this.fetchDevices();
        }
      } catch (err) {
        console.warn('Delete error:', err);
      }
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
      const btnOpen2 = document.getElementById('btn-open-device2-tab');
      if (btnOpen2) btnOpen2.href = `${trackUrl}?device=2`;
      const btnOpen3 = document.getElementById('btn-open-device3-tab');
      if (btnOpen3) btnOpen3.href = `${trackUrl}?device=3`;

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
