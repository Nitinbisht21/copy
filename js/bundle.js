/**
 * Geofence Map Builder - Combined Standalone Bundle
 * Works seamlessly on BOTH http://localhost servers AND direct file:// protocol!
 */

(function () {
  'use strict';

  /* ==========================================================================
     1. GEOFENCE ENGINE (SPATIAL & COORDINATE MATH)
     ========================================================================== */

  const GeofenceType = Object.freeze({
    CIRCLE: 'circle',
    RECTANGLE: 'rectangle',
    POLYGON: 'polygon'
  });

  const GeofenceStatus = Object.freeze({
    ACTIVE: 'active',
    DISABLED: 'disabled'
  });

  const EARTH_RADIUS_METERS = 6371008.8; // WGS84 mean radius

  function formatCoord(val, decimals = 6) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toFixed(decimals);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#39;');
  }

  function formatDistance(meters) {
    if (meters === null || meters === undefined || isNaN(meters)) return '—';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  function formatArea(sqMeters) {
    if (sqMeters === null || sqMeters === undefined || isNaN(sqMeters)) return '—';
    if (sqMeters >= 1_000_000) {
      return `${(sqMeters / 1_000_000).toFixed(3)} km²`;
    } else if (sqMeters >= 10_000) {
      return `${(sqMeters / 10_000).toFixed(2)} ha`;
    }
    return `${Math.round(sqMeters).toLocaleString()} m²`;
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (angle) => (angle * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const rLat1 = toRad(lat1);
    const rLat2 = toRad(lat2);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_METERS * c;
  }

  function getCircleMetrics(radiusMeters) {
    const radius = Math.max(0, Number(radiusMeters) || 0);
    const area = Math.PI * radius * radius;
    const circumference = 2 * Math.PI * radius;
    return { radius, area, circumference };
  }

  function getRectangleMetrics(north, south, east, west) {
    const n = Number(north);
    const s = Number(south);
    const e = Number(east);
    const w = Number(west);

    const midLat = (n + s) / 2;
    const widthMeters = haversineDistance(midLat, w, midLat, e);
    const midLng = (e + w) / 2;
    const heightMeters = haversineDistance(s, midLng, n, midLng);
    const areaMeters = widthMeters * heightMeters;
    const perimeterMeters = 2 * (widthMeters + heightMeters);

    return {
      north: n,
      south: s,
      east: e,
      west: w,
      widthMeters,
      heightMeters,
      areaMeters,
      perimeterMeters
    };
  }

  function calculatePolygonArea(coords) {
    if (!coords || coords.length < 3) return 0;
    const toRad = (angle) => (angle * Math.PI) / 180;
    let total = 0;
    const len = coords.length;

    for (let i = 0; i < len; i++) {
      const p1 = coords[i];
      const p2 = coords[(i + 1) % len];
      const lat1 = toRad(p1[0]);
      const lat2 = toRad(p2[0]);
      const dLon = toRad(p2[1] - p1[1]);
      total += dLon * (2 + Math.sin(lat1) + Math.sin(lat2));
    }

    return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 4);
  }

  function calculatePolygonPerimeter(coords) {
    if (!coords || coords.length < 2) return 0;
    let perimeter = 0;
    for (let i = 0; i < coords.length; i++) {
      const p1 = coords[i];
      const p2 = coords[(i + 1) % coords.length];
      perimeter += haversineDistance(p1[0], p1[1], p2[0], p2[1]);
    }
    return perimeter;
  }

  function isPointInCircle(point, center, radiusMeters) {
    const d = haversineDistance(point.lat, point.lng, center.lat, center.lng);
    return d <= radiusMeters;
  }

  function isPointInRectangle(point, bounds) {
    const lat = point.lat;
    const lng = point.lng;
    return (
      lat >= Math.min(bounds.south, bounds.north) &&
      lat <= Math.max(bounds.south, bounds.north) &&
      lng >= Math.min(bounds.west, bounds.east) &&
      lng <= Math.max(bounds.west, bounds.east)
    );
  }

  function isPointInPolygon(point, polygon) {
    const lat = point.lat;
    const lng = point.lng;
    let inside = false;
    const n = polygon.length;
    if (n < 3) return false;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];
      const intersect =
        ((yi > lng) !== (yj > lng)) &&
        (lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
      j = i;
    }
    return inside;
  }

  function isPointInGeofence(point, fence) {
    if (!fence || fence.status === GeofenceStatus.DISABLED) return false;
    let coords = fence.coordinates;
    if (typeof coords === 'string') {
      try { coords = JSON.parse(coords); } catch (e) { return false; }
    }
    if (!coords) return false;

    if (fence.type === GeofenceType.CIRCLE) {
      return isPointInCircle(point, coords, Number(fence.radius) || 200);
    } else if (fence.type === GeofenceType.RECTANGLE) {
      return isPointInRectangle(point, coords);
    } else if (fence.type === GeofenceType.POLYGON) {
      return isPointInPolygon(point, coords);
    }
    return false;
  }

  function generatePointInsideFence(fence) {
    if (!fence) return null;
    let coords = fence.coordinates;
    if (typeof coords === 'string') {
      try { coords = JSON.parse(coords); } catch (e) { return null; }
    }
    if (!coords) return null;

    if (fence.type === GeofenceType.CIRCLE) {
      const centerLat = Number(coords.lat);
      const centerLng = Number(coords.lng);
      const radius = Number(fence.radius) || 200;
      const r = (radius * 0.85) * Math.sqrt(0.05 + 0.95 * Math.random());
      const theta = Math.random() * 2 * Math.PI;
      const dLat = (r * Math.cos(theta)) / 111320.0;
      const dLng = (r * Math.sin(theta)) / (111320.0 * Math.cos((centerLat * Math.PI) / 180.0));
      return { lat: Number((centerLat + dLat).toFixed(6)), lng: Number((centerLng + dLng).toFixed(6)) };
    } else if (fence.type === GeofenceType.RECTANGLE) {
      const north = Number(coords.north);
      const south = Number(coords.south);
      const east = Number(coords.east);
      const west = Number(coords.west);
      const lat = south + (north - south) * (0.08 + 0.84 * Math.random());
      const lng = west + (east - west) * (0.08 + 0.84 * Math.random());
      return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    } else if (fence.type === GeofenceType.POLYGON) {
      const pts = coords;
      if (!Array.isArray(pts) || pts.length < 3) return null;
      const lats = pts.map(p => p[0]);
      const lngs = pts.map(p => p[1]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      for (let attempt = 0; attempt < 80; attempt++) {
        const candLat = minLat + (maxLat - minLat) * Math.random();
        const candLng = minLng + (maxLng - minLng) * Math.random();
        if (isPointInPolygon({ lat: candLat, lng: candLng }, pts)) {
          return { lat: Number(candLat.toFixed(6)), lng: Number(candLng.toFixed(6)) };
        }
      }
      return { lat: Number((lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(6)), lng: Number((lngs.reduce((a, b) => a + b, 0) / lngs.length).toFixed(6)) };
    }
    return null;
  }

  function createGeofenceModel({
    id = null,
    name = 'Unnamed Geofence',
    type = GeofenceType.CIRCLE,
    coordinates = null,
    radius = 200,
    status = GeofenceStatus.ACTIVE,
    color = '#2563eb',
    description = ''
  } = {}) {
    const now = new Date().toISOString();
    let safeCoords = coordinates;
    if (typeof safeCoords === 'string') {
      try {
        safeCoords = JSON.parse(safeCoords);
      } catch (e) {
        console.warn('Failed to parse coordinates string in model:', e);
      }
    }
    const model = {
      id: id || `geo_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: (name || 'Unnamed Geofence').trim(),
      type,
      coordinates: safeCoords,
      status: status === GeofenceStatus.DISABLED ? GeofenceStatus.DISABLED : GeofenceStatus.ACTIVE,
      color,
      description: (description || '').trim(),
      created_at: now,
      updated_at: now
    };
    if (type === GeofenceType.CIRCLE) {
      model.radius = Number(radius) || 200;
    }
    return model;
  }

  /* ==========================================================================
     2. GEOFENCE STORE (PERSISTENCE & CRUD)
     ========================================================================== */

  const STORAGE_KEY = 'geofence_map_builder_data_v1';
  const API_BASE = '/api/geofences';

  class GeofenceStore {
    constructor() {
      this.geofences = [];
      this.selectedGeofenceId = null;
      this.listeners = new Map();
      this.loadFromStorage();
      this.syncWithBackend();
    }

    on(event, callback) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event).add(callback);
      return () => this.off(event, callback);
    }

    off(event, callback) {
      if (this.listeners.has(event)) {
        this.listeners.get(event).delete(callback);
      }
    }

    emit(event, data) {
      if (this.listeners.has(event)) {
        for (const cb of this.listeners.get(event)) {
          try {
            cb(data);
          } catch (err) {
            console.error(`Error in event listener for ${event}:`, err);
          }
        }
      }
    }

    loadFromStorage() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.geofences = parsed;
            return;
          }
        }
      } catch (e) {
        console.warn('Failed to load geofences from localStorage:', e);
      }

      // Geofences are fetched directly from MongoDB (simulation_data_db.geofences)
      this.geofences = [];
    }

    async syncWithBackend() {
      try {
        const res = await fetch(API_BASE, { method: 'GET' });
        if (res.ok) {
          let remoteData = await res.json();
          // If MongoDB has no geofences, seed sample geofences into MongoDB
          if (!Array.isArray(remoteData) || remoteData.length === 0) {
            const seedRes = await fetch('/api/geofences/sample', { method: 'POST' });
            if (seedRes.ok) {
              remoteData = await seedRes.json();
            }
          }
          if (Array.isArray(remoteData) && remoteData.length > 0) {
            this.geofences = remoteData;
            this.saveToStorage();
            this.emit('store:changed', this.geofences);
            if (this.geofences.length > 0 && !this.selectedGeofenceId) {
              this.setSelected(this.geofences[0].id);
            }
          }
        }
      } catch (e) {
        // Offline or connection error
      }
    }

    saveToStorage() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.geofences));
      } catch (e) {
        console.error('Failed to save to localStorage:', e);
      }
    }

    getAll() {
      return [...this.geofences];
    }

    getActiveGeofences() {
      return (this.geofences || []).filter((g) => g.status === GeofenceStatus.ACTIVE);
    }

    getById(id) {
      return this.geofences.find((g) => g.id === id) || null;
    }

    getSelected() {
      return this.getById(this.selectedGeofenceId);
    }

    setSelected(id) {
      this.selectedGeofenceId = id;
      this.emit('selection:changed', this.getSelected());
    }

    clearSelected() {
      this.selectedGeofenceId = null;
      this.emit('selection:changed', null);
    }

    add(geofenceData) {
      const fence = createGeofenceModel(geofenceData);
      this.geofences.push(fence);
      this.saveToStorage();
      this.setSelected(fence.id);
      this.emit('fence:added', fence);
      this.emit('store:changed', this.geofences);

      // Async sync with Python backend
      fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fence)
      }).catch(() => {});

      return fence;
    }

    update(id, updates) {
      const idx = this.geofences.findIndex((g) => g.id === id);
      if (idx === -1) return null;

      const current = this.geofences[idx];
      const updated = {
        ...current,
        ...updates,
        updated_at: new Date().toISOString()
      };
      this.geofences[idx] = updated;
      this.saveToStorage();
      this.emit('fence:updated', updated);
      this.emit('store:changed', this.geofences);

      if (this.selectedGeofenceId === id) {
        this.emit('selection:changed', updated);
      }

      // Async sync with Python backend
      fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      }).catch(() => {});

      return updated;
    }

    delete(id) {
      const idx = this.geofences.findIndex((g) => g.id === id);
      if (idx === -1) return false;

      const removed = this.geofences.splice(idx, 1)[0];
      if (this.selectedGeofenceId === id) {
        this.clearSelected();
      }
      this.saveToStorage();
      this.emit('fence:deleted', removed);
      this.emit('store:changed', this.geofences);

      // Async sync with Python backend
      fetch(`${API_BASE}/${id}`, {
        method: 'DELETE'
      }).catch(() => {});

      return true;
    }

    toggleStatus(id) {
      const fence = this.getById(id);
      if (!fence) return null;

      const newStatus =
        fence.status === GeofenceStatus.ACTIVE ? GeofenceStatus.DISABLED : GeofenceStatus.ACTIVE;

      // Async sync with Python backend
      fetch(`${API_BASE}/${id}/toggle`, {
        method: 'POST'
      }).catch(() => {});

      return this.update(id, { status: newStatus });
    }

    clearAll() {
      this.geofences = [];
      this.clearSelected();
      this.saveToStorage();
      this.emit('store:cleared');
      this.emit('store:changed', this.geofences);

      // Async sync with Python backend
      fetch(API_BASE, {
        method: 'DELETE'
      }).catch(() => {});
    }

    toGeoJSON() {
      const features = this.geofences.map((g) => {
        let geometry = null;
        if (g.type === GeofenceType.CIRCLE) {
          geometry = {
            type: 'Point',
            coordinates: [g.coordinates.lng, g.coordinates.lat]
          };
        } else if (g.type === GeofenceType.RECTANGLE) {
          const { north, south, east, west } = g.coordinates;
          geometry = {
            type: 'Polygon',
            coordinates: [
              [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
                [west, north]
              ]
            ]
          };
        } else if (g.type === GeofenceType.POLYGON) {
          const ring = g.coordinates.map(([lat, lng]) => [lng, lat]);
          if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
            ring.push([...ring[0]]);
          }
          geometry = {
            type: 'Polygon',
            coordinates: [ring]
          };
        }

        return {
          type: 'Feature',
          id: g.id,
          properties: {
            name: g.name,
            type: g.type,
            radius: g.radius,
            status: g.status,
            color: g.color,
            description: g.description,
            created_at: g.created_at,
            updated_at: g.updated_at
          },
          geometry
        };
      });

      return {
        type: 'FeatureCollection',
        features
      };
    }

    importGeoJSON(geoJsonData) {
      if (!geoJsonData || geoJsonData.type !== 'FeatureCollection' || !Array.isArray(geoJsonData.features)) {
        throw new Error('Invalid GeoJSON FeatureCollection');
      }

      let count = 0;
      for (const feature of geoJsonData.features) {
        try {
          const props = feature.properties || {};
          const geom = feature.geometry;
          if (!geom) continue;

          let type = props.type || GeofenceType.POLYGON;
          let coords = null;
          let radius = props.radius || 0;

          if (geom.type === 'Point') {
            type = GeofenceType.CIRCLE;
            coords = { lat: geom.coordinates[1], lng: geom.coordinates[0] };
            radius = radius || 100;
          } else if (geom.type === 'Polygon') {
            const ring = geom.coordinates[0];
            if (!ring || ring.length < 3) continue;

            if (type === GeofenceType.RECTANGLE) {
              const lats = ring.map((p) => p[1]);
              const lngs = ring.map((p) => p[0]);
              coords = {
                north: Math.max(...lats),
                south: Math.min(...lats),
                east: Math.max(...lngs),
                west: Math.min(...lngs)
              };
            } else {
              type = GeofenceType.POLYGON;
              const cleanRing = ring.slice(0, ring.length - 1);
              coords = cleanRing.map((p) => [p[1], p[0]]);
            }
          }

          if (coords) {
            this.add({
              name: props.name || `Imported Geofence ${count + 1}`,
              type,
              coordinates: coords,
              radius,
              status: props.status || GeofenceStatus.ACTIVE,
              color: props.color || '#10b981',
              description: props.description || 'Imported from GeoJSON'
            });
            count++;
          }
        } catch (err) {
          console.warn('Skipping invalid feature:', err);
        }
      }
      return count;
    }
  }

  /* ==========================================================================
     3. MAP MANAGER (LEAFLET WRAPPER WITH INTERACTIVE DRAWING & HANDLES)
     ========================================================================== */

  const DrawingMode = Object.freeze({
    IDLE: 'idle',
    CIRCLE: 'circle',
    RECTANGLE: 'rectangle',
    POLYGON: 'polygon'
  });

  class MapManager {
    constructor({ containerId, onCursorMove, onMapMove, onDraftChange, onSelectGeofence, onFlagGenerated, onMouseFenceStatusChange, onMouseTelemetry }) {
      this.containerId = containerId;
      this.onCursorMove = onCursorMove || (() => {});
      this.onMapMove = onMapMove || (() => {});
      this.onDraftChange = onDraftChange || (() => {});
      this.onSelectGeofence = onSelectGeofence || (() => {});
      this.onFlagGenerated = onFlagGenerated || (() => {});
      this.onMouseFenceStatusChange = onMouseFenceStatusChange || (() => {});
      this.onMouseTelemetry = onMouseTelemetry || (() => {});
      this.lastMouseTelemetryTime = 0;

      this.map = null;
      this.currentMode = DrawingMode.IDLE;
      this.editingGeofenceId = null;

      this.tileLayers = {};
      this.activeTileLayerKey = 'google_streets';

      this.savedLayerGroup = null;
      this.draftLayerGroup = null;
      this.handlesLayerGroup = null;
      this.footprintsLayerGroup = null;
      this.flagMarkersLayerGroup = null;
      this.simulationAssetsLayerGroup = null;

      this.mouseTrackingEnabled = true;
      this.showFootprintsOnMap = true;
      this.showFlagsOnMap = true;
      this.mouseInsideFences = new Set();
      this.flagCount = 0;
      this.activeGeofencesList = [];
      this.assetMarkers = new Map();

      this.draftState = {
        type: null,
        circle: { center: null, radius: 200 },
        rectangle: { corner1: null, corner2: null, north: null, south: null, east: null, west: null },
        polygon: { points: [] }
      };

      this.polygonGuideLine = null;
      this.rectanglePreview = null;

      this.initMap();
    }

    initMap() {
      if (typeof L === 'undefined') {
        console.error('Leaflet library (L) is not loaded.');
        return;
      }

      // Default Rishikesh (30.123456, 78.123456)
      const initialCenter = [30.123456, 78.123456];
      const initialZoom = 15;

      this.map = L.map(this.containerId, {
        center: initialCenter,
        zoom: initialZoom,
        zoomControl: false,
        attributionControl: true
      });

      L.control.zoom({ position: 'topright' }).addTo(this.map);

      this.initTileLayers();

      this.savedLayerGroup = L.layerGroup().addTo(this.map);
      this.footprintsLayerGroup = L.layerGroup().addTo(this.map);
      this.flagMarkersLayerGroup = L.layerGroup().addTo(this.map);
      this.simulationAssetsLayerGroup = L.layerGroup().addTo(this.map);
      this.draftLayerGroup = L.layerGroup().addTo(this.map);
      this.handlesLayerGroup = L.layerGroup().addTo(this.map);

      this.setupEvents();
    }

    initTileLayers() {
      this.tileLayers = {
        google_streets: L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
          attribution: '&copy; Google Maps',
          maxZoom: 20
        }),
        google_hybrid: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
          attribution: '&copy; Google Maps',
          maxZoom: 20
        }),
        google_terrain: L.tileLayer('https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}', {
          attribution: '&copy; Google Maps',
          maxZoom: 20
        }),
        osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19
        }),
        esri_streets: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri',
          maxZoom: 19
        }),
        osm_hot: L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors, Humanitarian style',
          maxZoom: 19,
          subdomains: 'abc'
        }),
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri',
          maxZoom: 19
        }),
        topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap, SRTM | OpenTopoMap',
          maxZoom: 17,
          subdomains: 'abc'
        })
      };

      this.tileLayers[this.activeTileLayerKey].addTo(this.map);
    }

    setTileLayer(key) {
      if (!this.tileLayers[key]) return;
      if (this.activeTileLayerKey && this.tileLayers[this.activeTileLayerKey]) {
        this.map.removeLayer(this.tileLayers[this.activeTileLayerKey]);
      }
      this.activeTileLayerKey = key;
      this.tileLayers[key].addTo(this.map);
    }

    setupEvents() {
      this.map.on('mousemove', (e) => {
        const { lat, lng } = e.latlng;
        this.onCursorMove({ lat, lng });

        // Mouse Cross-Fence Flag Detection & Live Telemetry Stream
        if (this.mouseTrackingEnabled && this.activeGeofencesList && this.activeGeofencesList.length > 0) {
          const pt = { lat, lng };
          const nowInside = new Set();
          let insideFence = null;

          for (const fence of this.activeGeofencesList) {
            if (isPointInGeofence(pt, fence)) {
              nowInside.add(fence.id);
              insideFence = fence;

              // Check ENTER transition
              if (!this.mouseInsideFences.has(fence.id)) {
                this.handleFenceTransition('ENTER', fence, pt);
              }
            }
          }

          // Check EXIT transition
          for (const oldId of this.mouseInsideFences) {
            if (!nowInside.has(oldId)) {
              const exitedFence = this.activeGeofencesList.find(f => f.id === oldId);
              if (exitedFence) {
                this.handleFenceTransition('EXIT', exitedFence, pt);
              }
            }
          }

          // Live mouse movement stream to MongoDB (every 650ms while cursor is inside fence)
          const nowMs = Date.now();
          if (nowInside.size > 0 && insideFence && (nowMs - this.lastMouseTelemetryTime > 650)) {
            this.lastMouseTelemetryTime = nowMs;
            this.onMouseTelemetry({
              event: 'INSIDE',
              fence: insideFence,
              latlng: pt,
              timestamp: new Date()
            });
          }

          this.mouseInsideFences = nowInside;
          this.onMouseFenceStatusChange(insideFence ? insideFence.name : null, nowInside.size > 0);
        }

        if (this.currentMode === DrawingMode.POLYGON && this.draftState.polygon.points.length > 0) {
          this.updatePolygonGuideLine(e.latlng);
        }

        if (
          this.currentMode === DrawingMode.RECTANGLE &&
          this.draftState.rectangle.corner1 &&
          !this.draftState.rectangle.corner2
        ) {
          this.updateRectanglePreview(e.latlng);
        }
      });

      this.map.on('mouseout', () => {
        this.onCursorMove(null);
      });

      const notifyMapMove = () => {
        const center = this.map.getCenter();
        this.onMapMove({
          centerLat: center.lat,
          centerLng: center.lng,
          zoom: this.map.getZoom(),
          bounds: this.map.getBounds()
        });
      };

      this.map.on('move', notifyMapMove);
      this.map.on('zoomend', notifyMapMove);
      setTimeout(notifyMapMove, 100);

      this.map.on('click', (e) => {
        const pt = { lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) };
        // Stream mouse click coordinate event to MongoDB
        this.onMouseTelemetry({
          event: 'INSIDE',
          fence: null,
          latlng: pt,
          isClick: true,
          timestamp: new Date()
        });
        this.handleMapClick(e.latlng);
      });
    }

    setDrawingMode(mode, existingGeofence = null) {
      this.clearDraft();
      this.currentMode = mode;
      this.editingGeofenceId = existingGeofence ? existingGeofence.id : null;

      if (!this.map) return;

      if (mode === DrawingMode.IDLE) {
        this.editingGeofenceId = null;
        this.map.getContainer().style.cursor = '';
        return;
      }

      this.map.getContainer().style.cursor = 'crosshair';

      if (existingGeofence) {
        this.loadGeofenceIntoEdit(existingGeofence);
      } else {
        if (mode === DrawingMode.CIRCLE) {
          this.draftState.type = GeofenceType.CIRCLE;
          this.draftState.circle.radius = 200;
        } else if (mode === DrawingMode.RECTANGLE) {
          this.draftState.type = GeofenceType.RECTANGLE;
        } else if (mode === DrawingMode.POLYGON) {
          this.draftState.type = GeofenceType.POLYGON;
        }
      }
    }

    cancelDrawing() {
      this.editingGeofenceId = null;
      this.setDrawingMode(DrawingMode.IDLE);
      this.clearDraft();
    }

    clearDraft() {
      this.draftLayerGroup.clearLayers();
      this.handlesLayerGroup.clearLayers();
      this.draftState = {
        type: null,
        circle: { center: null, radius: 200 },
        rectangle: { corner1: null, corner2: null, north: null, south: null, east: null, west: null },
        polygon: { points: [] }
      };
      this.polygonGuideLine = null;
      this.rectanglePreview = null;
      this.onDraftChange(null);
    }

    handleMapClick(latlng) {
      if (this.currentMode === DrawingMode.CIRCLE) {
        this.setCircleCenter(latlng.lat, latlng.lng);
      } else if (this.currentMode === DrawingMode.RECTANGLE) {
        this.handleRectangleClick(latlng);
      } else if (this.currentMode === DrawingMode.POLYGON) {
        this.addPolygonPoint([latlng.lat, latlng.lng]);
      }
    }



    // Circle
    setCircleCenter(lat, lng, radius = null) {
      const center = { lat: Number(lat), lng: Number(lng) };
      const r = radius !== null ? Number(radius) : (this.draftState.circle.radius || 200);

      this.draftState.type = GeofenceType.CIRCLE;
      this.draftState.circle.center = center;
      this.draftState.circle.radius = r;

      this.renderCircleDraft();
      this.notifyDraftUpdated();
    }

    setCircleRadius(radiusMeters) {
      const r = Math.max(5, Number(radiusMeters) || 10);
      this.draftState.circle.radius = r;
      if (this.draftState.circle.center) {
        this.renderCircleDraft();
        this.notifyDraftUpdated();
      }
    }

    renderCircleDraft() {
      this.draftLayerGroup.clearLayers();
      this.handlesLayerGroup.clearLayers();

      const { center, radius } = this.draftState.circle;
      if (!center) return;

      const circleLayer = L.circle([center.lat, center.lng], {
        radius: radius,
        color: '#3b82f6',
        fillColor: '#60a5fa',
        fillOpacity: 0.25,
        weight: 3
      }).addTo(this.draftLayerGroup);

      const centerIcon = L.divIcon({
        className: 'custom-map-handle center-handle',
        html: `
          <div class="handle-pin-pulse"></div>
          <div class="handle-pin center-pin">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="4" fill="#3b82f6" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
            </svg>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });

      const centerMarker = L.marker([center.lat, center.lng], {
        icon: centerIcon,
        draggable: true,
        zIndexOffset: 1000
      }).addTo(this.handlesLayerGroup);

      centerMarker.on('drag', (e) => {
        const pos = e.target.getLatLng();
        this.draftState.circle.center = { lat: pos.lat, lng: pos.lng };
        circleLayer.setLatLng(pos);
        this.updateCircleRadiusHandlePosition();
        this.notifyDraftUpdated();
      });

      const handleLatLng = this.calculateRadiusHandlePos(center, radius);

      const radiusIcon = L.divIcon({
        className: 'custom-map-handle radius-handle',
        html: `
          <div class="handle-dot radius-dot" title="Drag to adjust radius">
            <span class="handle-badge">${Math.round(radius)}m</span>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const radiusMarker = L.marker(handleLatLng, {
        icon: radiusIcon,
        draggable: true,
        zIndexOffset: 1001
      }).addTo(this.handlesLayerGroup);

      this.circleRadiusMarker = radiusMarker;

      radiusMarker.on('drag', (e) => {
        const newPos = e.target.getLatLng();
        const newRadius = haversineDistance(
          this.draftState.circle.center.lat,
          this.draftState.circle.center.lng,
          newPos.lat,
          newPos.lng
        );
        const clampedRadius = Math.max(10, Math.round(newRadius));
        this.draftState.circle.radius = clampedRadius;
        circleLayer.setRadius(clampedRadius);

        const badge = radiusMarker.getElement()?.querySelector('.handle-badge');
        if (badge) badge.textContent = `${clampedRadius}m`;

        this.notifyDraftUpdated();
      });
    }

    calculateRadiusHandlePos(center, radiusMeters) {
      const latRad = (center.lat * Math.PI) / 180;
      const deltaLng = radiusMeters / (111320 * Math.cos(latRad));
      return [center.lat, center.lng + deltaLng];
    }

    updateCircleRadiusHandlePosition() {
      if (!this.circleRadiusMarker || !this.draftState.circle.center) return;
      const pos = this.calculateRadiusHandlePos(
        this.draftState.circle.center,
        this.draftState.circle.radius
      );
      this.circleRadiusMarker.setLatLng(pos);
    }

    // Rectangle
    handleRectangleClick(latlng) {
      if (!this.draftState.rectangle.corner1) {
        this.draftState.type = GeofenceType.RECTANGLE;
        this.draftState.rectangle.corner1 = latlng;
        this.renderRectangleCornerMarker(latlng);
        this.notifyDraftUpdated();
      } else if (!this.draftState.rectangle.corner2) {
        this.draftState.rectangle.corner2 = latlng;
        this.finalizeRectangleFromCorners();
      }
    }

    updateRectanglePreview(cursorLatLng) {
      if (!this.draftState.rectangle.corner1) return;
      const c1 = this.draftState.rectangle.corner1;
      const bounds = L.latLngBounds(c1, cursorLatLng);

      if (!this.rectanglePreview) {
        this.rectanglePreview = L.rectangle(bounds, {
          color: '#8b5cf6',
          dashArray: '6, 6',
          weight: 2,
          fillColor: '#a78bfa',
          fillOpacity: 0.15
        }).addTo(this.draftLayerGroup);
      } else {
        this.rectanglePreview.setBounds(bounds);
      }
    }

    finalizeRectangleFromCorners() {
      const { corner1, corner2 } = this.draftState.rectangle;
      if (!corner1 || !corner2) return;

      const north = Math.max(corner1.lat, corner2.lat);
      const south = Math.min(corner1.lat, corner2.lat);
      const east = Math.max(corner1.lng, corner2.lng);
      const west = Math.min(corner1.lng, corner2.lng);

      this.setRectangleBounds(north, south, east, west);
    }

    setRectangleBounds(north, south, east, west) {
      this.draftState.type = GeofenceType.RECTANGLE;
      this.draftState.rectangle.north = Number(north);
      this.draftState.rectangle.south = Number(south);
      this.draftState.rectangle.east = Number(east);
      this.draftState.rectangle.west = Number(west);
      this.draftState.rectangle.corner1 = { lat: north, lng: west };
      this.draftState.rectangle.corner2 = { lat: south, lng: east };

      this.renderRectangleDraft();
      this.notifyDraftUpdated();
    }

    renderRectangleCornerMarker(latlng) {
      const icon = L.divIcon({
        className: 'custom-map-handle corner-pin-icon',
        html: `<div class="corner-dot pulse"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      L.marker(latlng, { icon, interactive: false }).addTo(this.handlesLayerGroup);
    }

    renderRectangleDraft() {
      this.draftLayerGroup.clearLayers();
      this.handlesLayerGroup.clearLayers();
      this.rectanglePreview = null;

      const { north, south, east, west } = this.draftState.rectangle;
      if (north === null || south === null) return;

      const bounds = [
        [south, west],
        [north, east]
      ];

      L.rectangle(bounds, {
        color: '#8b5cf6',
        fillColor: '#a78bfa',
        fillOpacity: 0.25,
        weight: 3
      }).addTo(this.draftLayerGroup);

      const corners = [
        { id: 'nw', lat: north, lng: west, label: 'NW Corner' },
        { id: 'ne', lat: north, lng: east, label: 'NE Corner' },
        { id: 'se', lat: south, lng: east, label: 'SE Corner' },
        { id: 'sw', lat: south, lng: west, label: 'SW Corner' }
      ];

      corners.forEach((corner) => {
        const cornerIcon = L.divIcon({
          className: 'custom-map-handle corner-handle',
          html: `<div class="handle-dot corner-dot" title="${corner.label}"></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        const marker = L.marker([corner.lat, corner.lng], {
          icon: cornerIcon,
          draggable: true,
          zIndexOffset: 1000
        }).addTo(this.handlesLayerGroup);

        marker.on('drag', (e) => {
          const newPos = e.target.getLatLng();
          let n = this.draftState.rectangle.north;
          let s = this.draftState.rectangle.south;
          let ea = this.draftState.rectangle.east;
          let w = this.draftState.rectangle.west;

          if (corner.id === 'nw') {
            n = Math.max(newPos.lat, s + 0.0001);
            w = Math.min(newPos.lng, ea - 0.0001);
          } else if (corner.id === 'ne') {
            n = Math.max(newPos.lat, s + 0.0001);
            ea = Math.max(newPos.lng, w + 0.0001);
          } else if (corner.id === 'se') {
            s = Math.min(newPos.lat, n - 0.0001);
            ea = Math.max(newPos.lng, w + 0.0001);
          } else if (corner.id === 'sw') {
            s = Math.min(newPos.lat, n - 0.0001);
            w = Math.min(newPos.lng, ea - 0.0001);
          }

          this.setRectangleBounds(n, s, ea, w);
        });
      });

      const centerLat = (north + south) / 2;
      const centerLng = (east + west) / 2;
      const centerIcon = L.divIcon({
        className: 'custom-map-handle center-rect-handle',
        html: `
          <div class="handle-center-chip" title="Drag to move entire box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="5 9 2 12 5 15"></polyline>
              <polyline points="9 5 12 2 15 5"></polyline>
              <polyline points="15 19 12 22 9 19"></polyline>
              <polyline points="19 9 22 12 19 15"></polyline>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <line x1="12" y1="2" x2="12" y2="22"></line>
            </svg>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const centerMarker = L.marker([centerLat, centerLng], {
        icon: centerIcon,
        draggable: true,
        zIndexOffset: 999
      }).addTo(this.handlesLayerGroup);

      let lastDragPos = { lat: centerLat, lng: centerLng };

      centerMarker.on('dragstart', () => {
        lastDragPos = centerMarker.getLatLng();
      });

      centerMarker.on('drag', (e) => {
        const curPos = e.target.getLatLng();
        const dLat = curPos.lat - lastDragPos.lat;
        const dLng = curPos.lng - lastDragPos.lng;
        lastDragPos = curPos;

        const n = this.draftState.rectangle.north + dLat;
        const s = this.draftState.rectangle.south + dLat;
        const ea = this.draftState.rectangle.east + dLng;
        const w = this.draftState.rectangle.west + dLng;

        this.setRectangleBounds(n, s, ea, w);
      });
    }

    // Polygon
    addPolygonPoint(point) {
      this.draftState.type = GeofenceType.POLYGON;
      this.draftState.polygon.points.push([Number(point[0]), Number(point[1])]);
      this.renderPolygonDraft();
      this.notifyDraftUpdated();
    }

    setPolygonPoints(points) {
      this.draftState.type = GeofenceType.POLYGON;
      this.draftState.polygon.points = points.map((p) => [Number(p[0]), Number(p[1])]);
      this.renderPolygonDraft();
      this.notifyDraftUpdated();
    }

    updatePolygonPoint(index, newLatLng) {
      if (index >= 0 && index < this.draftState.polygon.points.length) {
        this.draftState.polygon.points[index] = [newLatLng.lat, newLatLng.lng];
        this.renderPolygonDraft();
        this.notifyDraftUpdated();
      }
    }

    deletePolygonPoint(index) {
      if (index >= 0 && index < this.draftState.polygon.points.length) {
        this.draftState.polygon.points.splice(index, 1);
        this.renderPolygonDraft();
        this.notifyDraftUpdated();
      }
    }

    updatePolygonGuideLine(cursorLatLng) {
      const pts = this.draftState.polygon.points;
      if (pts.length === 0) return;

      const lastPt = pts[pts.length - 1];
      const lineCoords = [lastPt, [cursorLatLng.lat, cursorLatLng.lng]];

      if (!this.polygonGuideLine) {
        this.polygonGuideLine = L.polyline(lineCoords, {
          color: '#10b981',
          weight: 2,
          dashArray: '4, 4'
        }).addTo(this.draftLayerGroup);
      } else {
        this.polygonGuideLine.setLatLngs(lineCoords);
      }
    }

    finishPolygon() {
      if (this.draftState.polygon.points.length < 3) {
        return false;
      }
      if (this.polygonGuideLine) {
        this.draftLayerGroup.removeLayer(this.polygonGuideLine);
        this.polygonGuideLine = null;
      }
      this.renderPolygonDraft();
      this.notifyDraftUpdated();
      return true;
    }

    renderPolygonDraft() {
      this.draftLayerGroup.clearLayers();
      this.handlesLayerGroup.clearLayers();
      this.polygonGuideLine = null;

      const points = this.draftState.polygon.points;
      if (points.length === 0) return;

      if (points.length >= 3) {
        L.polygon(points, {
          color: '#10b981',
          fillColor: '#34d399',
          fillOpacity: 0.25,
          weight: 3
        }).addTo(this.draftLayerGroup);
      } else if (points.length === 2) {
        L.polyline(points, {
          color: '#10b981',
          weight: 3
        }).addTo(this.draftLayerGroup);
      }

      points.forEach((pt, idx) => {
        const vertexIcon = L.divIcon({
          className: 'custom-map-handle vertex-handle',
          html: `
            <div class="vertex-dot ${idx === 0 ? 'first-vertex' : ''}" title="Point ${idx + 1}">
              <span class="vertex-num">${idx + 1}</span>
            </div>
          `,
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        });

        const marker = L.marker(pt, {
          icon: vertexIcon,
          draggable: true,
          zIndexOffset: 1000 + idx
        }).addTo(this.handlesLayerGroup);

        marker.on('drag', (e) => {
          const newPos = e.target.getLatLng();
          this.updatePolygonPoint(idx, newPos);
        });

        if (idx === 0 && points.length >= 3) {
          marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.finishPolygon();
          });
        }
      });
    }

    loadGeofenceIntoEdit(geofence) {
      this.clearDraft();
      this.editingGeofenceId = geofence.id;

      if (geofence.type === GeofenceType.CIRCLE) {
        this.currentMode = DrawingMode.CIRCLE;
        this.setCircleCenter(geofence.coordinates.lat, geofence.coordinates.lng, geofence.radius);
      } else if (geofence.type === GeofenceType.RECTANGLE) {
        this.currentMode = DrawingMode.RECTANGLE;
        const { north, south, east, west } = geofence.coordinates;
        this.setRectangleBounds(north, south, east, west);
      } else if (geofence.type === GeofenceType.POLYGON) {
        this.currentMode = DrawingMode.POLYGON;
        this.setPolygonPoints(geofence.coordinates);
      }

      this.zoomToGeofence(geofence);
    }

    notifyDraftUpdated() {
      let payload = null;

      if (this.draftState.type === GeofenceType.CIRCLE && this.draftState.circle.center) {
        const { center, radius } = this.draftState.circle;
        const metrics = getCircleMetrics(radius);
        payload = {
          type: GeofenceType.CIRCLE,
          coordinates: center,
          radius: metrics.radius,
          area: metrics.area,
          circumference: metrics.circumference,
          isValid: true
        };
      } else if (this.draftState.type === GeofenceType.RECTANGLE && this.draftState.rectangle.north !== null) {
        const { north, south, east, west } = this.draftState.rectangle;
        const metrics = getRectangleMetrics(north, south, east, west);
        payload = {
          type: GeofenceType.RECTANGLE,
          coordinates: { north, south, east, west },
          widthMeters: metrics.widthMeters,
          heightMeters: metrics.heightMeters,
          areaMeters: metrics.areaMeters,
          perimeterMeters: metrics.perimeterMeters,
          isValid: north > south && east > west
        };
      } else if (this.draftState.type === GeofenceType.POLYGON) {
        const points = this.draftState.polygon.points;
        const area = calculatePolygonArea(points);
        const perimeter = calculatePolygonPerimeter(points);
        payload = {
          type: GeofenceType.POLYGON,
          coordinates: points,
          pointsCount: points.length,
          area,
          perimeter,
          isValid: points.length >= 3
        };
      }

      this.onDraftChange(payload);
    }

    renderSavedGeofences(geofences, selectedId = null) {
      this.savedLayerGroup.clearLayers();
      this.activeGeofencesList = (geofences || []).filter(f => f.status === 'active');

      geofences.forEach((fence) => {
        if (this.editingGeofenceId && fence.id === this.editingGeofenceId) {
          return;
        }

        let coords = fence.coordinates;
        if (typeof coords === 'string') {
          try {
            coords = JSON.parse(coords);
          } catch (e) {
            console.warn('Failed to parse coordinates for fence:', fence.id, e);
          }
        }
        if (!coords) return;

        const isSelected = fence.id === selectedId;
        const isActive = fence.status === GeofenceStatus.ACTIVE;

        const style = {
          color: isActive ? fence.color || '#2563eb' : '#94a3b8',
          fillColor: isActive ? fence.color || '#3b82f6' : '#cbd5e1',
          fillOpacity: isActive ? (isSelected ? 0.4 : 0.2) : 0.08,
          weight: isSelected ? 4 : 2,
          dashArray: isActive ? null : '6, 6'
        };

        let layer = null;

        if (fence.type === GeofenceType.CIRCLE) {
          const lat = Number(coords.lat);
          const lng = Number(coords.lng);
          const radius = Number(fence.radius) || 200;
          if (isNaN(lat) || isNaN(lng)) return;

          layer = L.circle([lat, lng], {
            radius: radius,
            ...style
          });

          const centerIcon = L.divIcon({
            className: 'saved-center-marker',
            html: `<div class="saved-dot ${isActive ? 'active' : 'disabled'}" style="background-color: ${style.color}"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          });
          const centerMarker = L.marker([lat, lng], {
            icon: centerIcon,
            interactive: true
          });
          centerMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.onSelectGeofence(fence.id);
          });
          centerMarker.addTo(this.savedLayerGroup);
        } else if (fence.type === GeofenceType.RECTANGLE) {
          const north = Number(coords.north);
          const south = Number(coords.south);
          const east = Number(coords.east);
          const west = Number(coords.west);
          if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) return;

          layer = L.rectangle(
            [
              [south, west],
              [north, east]
            ],
            style
          );
        } else if (fence.type === GeofenceType.POLYGON) {
          if (!Array.isArray(coords) || coords.length < 3) return;
          layer = L.polygon(coords, style);
        }

        if (layer) {
          layer.bindTooltip(
            `<div class="geofence-tooltip">
              <strong>${fence.name}</strong>
              <span class="tooltip-badge ${fence.status}">${fence.type.toUpperCase()} &bull; ${fence.status}</span>
            </div>`,
            { sticky: true, className: 'custom-leaflet-tooltip' }
          );

          layer.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.onSelectGeofence(fence.id);
          });

          layer.addTo(this.savedLayerGroup);
        }
      });
    }

    escapeHtml(str) {
      return escapeHtml(str);
    }

    handleFenceTransition(type, fence, pt) {
      this.flagCount++;
      if (this.showFlagsOnMap) {
        this.generateFlagMarker(type, fence, pt);
      }
      this.onFlagGenerated({ event: type, fence, latlng: pt, timestamp: new Date() });
    }

    generateFlagMarker(type, fence, pt) {
      if (!this.flagMarkersLayerGroup) return;
      const isEnter = type === 'ENTER';
      const flagColor = isEnter ? '#10b981' : '#ef4444';
      const flagHtml = `
        <div class="generated-flag-marker ${isEnter ? 'flag-enter' : 'flag-exit'}">
          <div class="flag-radar-pulse"></div>
          <div class="flag-pin-bubble" style="background-color: ${flagColor};">
            <span>🚩</span>
            <span>${type}: ${this.escapeHtml(fence.name)}</span>
          </div>
        </div>
      `;

      const flagIcon = L.divIcon({
        className: 'custom-generated-flag',
        html: flagHtml,
        iconSize: [140, 36],
        iconAnchor: [18, 30]
      });

      const marker = L.marker([pt.lat, pt.lng], { icon: flagIcon, zIndexOffset: 2000 }).addTo(this.flagMarkersLayerGroup);
      marker.bindPopup(`
        <div style="font-family: inherit; font-size: 0.8rem; line-height: 1.4;">
          <strong style="color: ${flagColor};">🚩 GEOFENCE ${type} FLAG GENERATED</strong><br>
          <strong>Fence:</strong> ${this.escapeHtml(fence.name)}<br>
          <strong>Coordinates:</strong> ${formatCoord(pt.lat)}, ${formatCoord(pt.lng)}<br>
          <strong>Trigger:</strong> Mouse Cross-Fence Boundary
        </div>
      `);
    }

    renderFootprintPoint(latlng, options = {}) {
      if (!this.footprintsLayerGroup) return;
      const lat = Array.isArray(latlng) ? latlng[0] : latlng.lat;
      const lng = Array.isArray(latlng) ? latlng[1] : latlng.lng;
      if (isNaN(lat) || isNaN(lng)) return;

      const color = options.color || options.fenceColor || '#2563eb';

      const dotIcon = L.divIcon({
        className: 'footprint-icon-container',
        html: `
          <div class="footprint-marker-wrap">
            <div class="footprint-pulse-ring" style="border-color: ${color};"></div>
            <div class="footprint-icon-marker" style="background-color: ${color}; box-shadow: 0 0 10px ${color};">
              <span class="footprint-icon-symbol">👣</span>
            </div>
          </div>
        `,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      const marker = L.marker([lat, lng], { icon: dotIcon, zIndexOffset: 800 }).addTo(this.footprintsLayerGroup);
      if (options.device || options.fenceName) {
        marker.bindTooltip(`
          <div style="font-size: 0.72rem; font-family: monospace;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${color}; box-shadow: 0 0 4px ${color};"></span>
              <strong>👣 ${this.escapeHtml(options.device || 'Simulated Target')}</strong>
            </div>
            <span>Zone: <strong>${this.escapeHtml(options.fenceName || 'Active Fence Area')}</strong></span><br>
            <span style="color: var(--text-muted);">${formatCoord(lat)}, ${formatCoord(lng)}</span>
          </div>
        `, { sticky: true });
      }
    }

    clearFootprintsOnMap() {
      if (this.footprintsLayerGroup) this.footprintsLayerGroup.clearLayers();
    }

    clearFlagMarkersOnMap() {
      if (this.flagMarkersLayerGroup) this.flagMarkersLayerGroup.clearLayers();
      this.flagCount = 0;
    }

    updateSimulatedAsset(assetId, name, latlng, color = '#3b82f6') {
      if (!this.simulationAssetsLayerGroup) return;
      let marker = this.assetMarkers.get(assetId);

      const html = `
        <div class="asset-marker-bubble" style="border-color: ${color};">
          <div class="asset-pulse" style="background: ${color}; box-shadow: 0 0 6px ${color};"></div>
          <span>${this.escapeHtml(name)}</span>
        </div>
      `;

      const icon = L.divIcon({
        className: 'simulated-asset-icon',
        html: html,
        iconSize: [95, 24],
        iconAnchor: [47, 12]
      });

      if (!marker) {
        marker = L.marker([latlng.lat, latlng.lng], { icon: icon, zIndexOffset: 2500 }).addTo(this.simulationAssetsLayerGroup);
        this.assetMarkers.set(assetId, marker);
      } else {
        marker.setLatLng([latlng.lat, latlng.lng]);
        marker.setIcon(icon);
      }
    }

    clearSimulatedAssets() {
      if (this.simulationAssetsLayerGroup) this.simulationAssetsLayerGroup.clearLayers();
      this.assetMarkers.clear();
    }

    setLayerVisibility(type, visible) {
      if (type === 'footprints' && this.footprintsLayerGroup) {
        this.showFootprintsOnMap = visible;
        if (visible) {
          if (!this.map.hasLayer(this.footprintsLayerGroup)) this.map.addLayer(this.footprintsLayerGroup);
        } else {
          if (this.map.hasLayer(this.footprintsLayerGroup)) this.map.removeLayer(this.footprintsLayerGroup);
        }
      } else if (type === 'flags' && this.flagMarkersLayerGroup) {
        this.showFlagsOnMap = visible;
        if (visible) {
          if (!this.map.hasLayer(this.flagMarkersLayerGroup)) this.map.addLayer(this.flagMarkersLayerGroup);
        } else {
          if (this.map.hasLayer(this.flagMarkersLayerGroup)) this.map.removeLayer(this.flagMarkersLayerGroup);
        }
      }
    }

    zoomToGeofence(geofence) {
      if (!this.map || !geofence) return;

      let coords = geofence.coordinates;
      if (typeof coords === 'string') {
        try {
          coords = JSON.parse(coords);
        } catch (e) {}
      }
      if (!coords) return;

      if (geofence.type === GeofenceType.CIRCLE) {
        const lat = Number(coords.lat);
        const lng = Number(coords.lng);
        if (isNaN(lat) || isNaN(lng)) return;
        const circle = L.circle([lat, lng], {
          radius: Number(geofence.radius) || 200
        });
        this.map.fitBounds(circle.getBounds(), { padding: [50, 50], maxZoom: 17 });
      } else if (geofence.type === GeofenceType.RECTANGLE) {
        const north = Number(coords.north);
        const south = Number(coords.south);
        const east = Number(coords.east);
        const west = Number(coords.west);
        if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) return;
        this.map.fitBounds(
          [
            [south, west],
            [north, east]
          ],
          { padding: [50, 50], maxZoom: 17 }
        );
      } else if (geofence.type === GeofenceType.POLYGON) {
        if (!Array.isArray(coords) || coords.length < 3) return;
        const poly = L.polygon(coords);
        this.map.fitBounds(poly.getBounds(), { padding: [50, 50], maxZoom: 17 });
      }
    }

    fitAll(geofences) {
      if (!this.map || !geofences || geofences.length === 0) return;
      const bounds = L.latLngBounds();

      geofences.forEach((fence) => {
        let coords = fence.coordinates;
        if (typeof coords === 'string') {
          try {
            coords = JSON.parse(coords);
          } catch (e) {}
        }
        if (!coords) return;

        if (fence.type === GeofenceType.CIRCLE) {
          const lat = Number(coords.lat);
          const lng = Number(coords.lng);
          if (!isNaN(lat) && !isNaN(lng)) {
            const c = L.circle([lat, lng], { radius: Number(fence.radius) || 200 });
            bounds.extend(c.getBounds());
          }
        } else if (fence.type === GeofenceType.RECTANGLE) {
          const north = Number(coords.north);
          const south = Number(coords.south);
          const east = Number(coords.east);
          const west = Number(coords.west);
          if (!isNaN(north) && !isNaN(south) && !isNaN(east) && !isNaN(west)) {
            bounds.extend([
              [south, west],
              [north, east]
            ]);
          }
        } else if (fence.type === GeofenceType.POLYGON) {
          if (Array.isArray(coords)) {
            coords.forEach((pt) => {
              if (Array.isArray(pt) && !isNaN(pt[0]) && !isNaN(pt[1])) {
                bounds.extend(pt);
              }
            });
          }
        }
      });

      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
      }
    }

    panToLocation(lat, lng, zoom = 16) {
      if (this.map) {
        this.map.flyTo([lat, lng], zoom, { duration: 1.2 });
      }
    }

    locateUser() {
      if (!navigator.geolocation) {
        return Promise.reject(new Error('Geolocation not supported by your browser'));
      }

      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            this.panToLocation(latitude, longitude, 16);

            const locIcon = L.divIcon({
              className: 'user-location-pin',
              html: `<div class="user-pulse"></div><div class="user-dot"></div>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12]
            });
            const locMarker = L.marker([latitude, longitude], { icon: locIcon }).addTo(this.map);
            setTimeout(() => this.map.removeLayer(locMarker), 8000);

            resolve({ lat: latitude, lng: longitude });
          },
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 8000 }
        );
      });
    }
  }

  /* ==========================================================================
     4. UI CONTROLLER (DOM BINDINGS & COORDINATE PANEL)
     ========================================================================== */

  class UIController {
    constructor({ store, mapManager }) {
      this.store = store;
      this.mapManager = mapManager;

      this.currentMode = DrawingMode.CIRCLE;
      this.editingGeofence = null;
      this.activeDraftPayload = null;
      this.isAddMode = false;

      this.initElements();
      this.bindEvents();
      this.bindStoreEvents();
      this.renderSavedList();

      const first = this.store.getAll()[0];
      if (first) {
        this.store.setSelected(first.id);
      }
      this.enterExploreMode();
      // Start fresh without past clutter on map; past logs can be refreshed manually via ↻ button
      this.loadDatabaseStatus();
      setInterval(() => this.loadDatabaseStatus(), 8000);
    }

    initElements() {
      this.dbStatusBadge = document.getElementById('db-status-badge');
      this.dbStatusText = document.getElementById('db-status-text');
      this.compassUri = 'mongodb://localhost:27017/';

      this.modeButtons = document.querySelectorAll('[data-mode]');
      this.modeSections = {
        [GeofenceType.CIRCLE]: document.getElementById('section-circle'),
        [GeofenceType.RECTANGLE]: document.getElementById('section-rectangle'),
        [GeofenceType.POLYGON]: document.getElementById('section-polygon')
      };

      this.btnStartAdd = document.getElementById('btn-start-add');
      this.btnExploreMode = document.getElementById('btn-explore-mode');
      this.modeSelectorSection = document.getElementById('mode-selector-section');
      this.formCard = document.querySelector('.form-card');

      // Simulation & Mouse Flag Controls
      this.toggleMouseTracking = document.getElementById('toggle-mouse-tracking');
      this.btnToggleSimulation = document.getElementById('btn-toggle-simulation');
      this.btnSimulationIcon = document.getElementById('btn-simulation-icon');
      this.btnSimulationText = document.getElementById('btn-simulation-text');
      this.btnGenerateFootprints = document.getElementById('btn-generate-footprints');
      this.toggleShowFootprints = document.getElementById('toggle-show-footprints');
      this.toggleShowFlags = document.getElementById('toggle-show-flags');
      this.footprintsLogList = document.getElementById('footprints-log-list');
      this.footprintCountBadge = document.getElementById('footprint-count-badge');
      this.btnRefreshFootprints = document.getElementById('btn-refresh-footprints');
      this.btnClearFootprints = document.getElementById('btn-clear-footprints');
      this.btnCreateSampleFences = document.getElementById('btn-create-sample-fences');
      this.hudMouseFence = document.getElementById('hud-mouse-fence-val');
      this.hudFlagCount = document.getElementById('hud-flag-count-val');

      this.simulationRunning = false;
      this.simulationTimer = null;
      this.simulatedAssets = [
        { id: 'DRONE_ALPHA', name: 'Drone Alpha', color: '#10b981', coords: null },
        { id: 'PATROL_101', name: 'Patrol 101', color: '#3b82f6', coords: null },
        { id: 'SCOUT_VEHICLE', name: 'Scout 9', color: '#f59e0b', coords: null }
      ];

      this.inputCircleLat = document.getElementById('circle-lat');
      this.inputCircleLng = document.getElementById('circle-lng');
      this.inputCircleRadius = document.getElementById('circle-radius');
      this.sliderCircleRadius = document.getElementById('circle-radius-slider');
      this.radiusPresets = document.querySelectorAll('[data-radius-preset]');

      this.inputRectNorth = document.getElementById('rect-north');
      this.inputRectSouth = document.getElementById('rect-south');
      this.inputRectEast = document.getElementById('rect-east');
      this.inputRectWest = document.getElementById('rect-west');

      this.btnFinishPolygon = document.getElementById('btn-finish-polygon');
      this.btnClearPolygon = document.getElementById('btn-clear-polygon');
      this.polygonPointsCount = document.getElementById('polygon-points-count');
      this.polygonPointsList = document.getElementById('polygon-draft-points');

      this.inputFenceName = document.getElementById('fence-name');
      this.inputFenceDesc = document.getElementById('fence-desc');
      this.inputFenceStatus = document.getElementById('fence-status');
      this.colorRadios = document.querySelectorAll('input[name="fence-color"]');
      this.btnSaveGeofence = document.getElementById('btn-save-geofence');
      this.btnCancelGeofence = document.getElementById('btn-cancel-geofence');
      this.btnClearShape = document.getElementById('btn-clear-shape');
      this.formTitle = document.getElementById('form-card-title');
      this.drawingInstruction = document.getElementById('drawing-instruction');

      this.detailsPanel = document.getElementById('geofence-details-panel');
      this.detailsContent = document.getElementById('details-content');
      this.detailsEmptyState = document.getElementById('details-empty-state');
      this.btnCopyCoords = document.getElementById('btn-copy-coords');
      this.btnEditFromDetails = document.getElementById('btn-edit-from-details');
      this.btnDeleteFromDetails = document.getElementById('btn-delete-from-details');

      this.savedListContainer = document.getElementById('saved-fences-list');
      this.savedCountBadge = document.getElementById('saved-count-badge');
      this.savedSearchInput = document.getElementById('saved-search-input');
      this.btnExportGeoJSON = document.getElementById('btn-export-geojson');
      this.btnImportGeoJSON = document.getElementById('btn-import-geojson');
      this.fileImportInput = document.getElementById('file-import-input');
      this.btnClearAllFences = document.getElementById('btn-clear-all-fences');

      this.hudCursor = document.getElementById('hud-cursor-coords');
      this.hudCenter = document.getElementById('hud-center-coords');
      this.hudZoom = document.getElementById('hud-zoom-level');

      this.tileSelect = document.getElementById('tile-layer-select');
      this.btnFitAll = document.getElementById('btn-fit-all');
      this.btnLocateMe = document.getElementById('btn-locate-me');
      this.locationSearchInput = document.getElementById('location-search-input');
      this.locationSearchResults = document.getElementById('location-search-results');

      this.toastContainer = document.getElementById('toast-container');

      this.confirmModal = document.getElementById('confirm-modal');
      this.confirmTitle = document.getElementById('confirm-title');
      this.confirmMessage = document.getElementById('confirm-message');
      this.confirmBtnOk = document.getElementById('confirm-btn-ok');
      this.confirmBtnCancel = document.getElementById('confirm-btn-cancel');
      this.onConfirmCallback = null;
    }

    bindEvents() {
      if (this.btnStartAdd) {
        this.btnStartAdd.addEventListener('click', () => {
          this.enterAddMode();
        });
      }

      if (this.btnExploreMode) {
        this.btnExploreMode.addEventListener('click', () => {
          this.enterExploreMode();
        });
      }

      this.modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          this.enterAddMode(mode);
        });
      });

      const onCircleInputChange = () => {
        const lat = parseFloat(this.inputCircleLat.value);
        const lng = parseFloat(this.inputCircleLng.value);
        const radius = parseFloat(this.inputCircleRadius.value) || 200;

        if (!isNaN(lat) && !isNaN(lng)) {
          this.mapManager.setCircleCenter(lat, lng, radius);
        }
      };

      this.inputCircleLat.addEventListener('input', onCircleInputChange);
      this.inputCircleLng.addEventListener('input', onCircleInputChange);

      this.inputCircleRadius.addEventListener('input', (e) => {
        const val = Math.max(10, Number(e.target.value) || 10);
        this.sliderCircleRadius.value = Math.min(3000, val);
        this.mapManager.setCircleRadius(val);
      });

      this.sliderCircleRadius.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        this.inputCircleRadius.value = val;
        this.mapManager.setCircleRadius(val);
      });

      this.radiusPresets.forEach((pill) => {
        pill.addEventListener('click', () => {
          const val = Number(pill.dataset.radiusPreset);
          this.inputCircleRadius.value = val;
          this.sliderCircleRadius.value = Math.min(3000, val);
          this.mapManager.setCircleRadius(val);
        });
      });

      const onRectInputChange = () => {
        const n = parseFloat(this.inputRectNorth.value);
        const s = parseFloat(this.inputRectSouth.value);
        const e = parseFloat(this.inputRectEast.value);
        const w = parseFloat(this.inputRectWest.value);

        if (!isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w) && n > s && e > w) {
          this.mapManager.setRectangleBounds(n, s, e, w);
        }
      };

      [this.inputRectNorth, this.inputRectSouth, this.inputRectEast, this.inputRectWest].forEach(
        (input) => input.addEventListener('input', onRectInputChange)
      );

      if (this.toggleMouseTracking) {
        this.toggleMouseTracking.addEventListener('change', () => {
          this.mapManager.mouseTrackingEnabled = this.toggleMouseTracking.checked;
          if (!this.toggleMouseTracking.checked && this.hudMouseFence) {
            this.hudMouseFence.innerHTML = '<span style="color:var(--text-muted);">Tracking Disabled</span>';
          }
        });
      }

      if (this.toggleShowFootprints) {
        this.toggleShowFootprints.addEventListener('change', () => {
          this.mapManager.setLayerVisibility('footprints', this.toggleShowFootprints.checked);
        });
      }

      if (this.toggleShowFlags) {
        this.toggleShowFlags.addEventListener('change', () => {
          this.mapManager.setLayerVisibility('flags', this.toggleShowFlags.checked);
        });
      }

      if (this.btnToggleSimulation) {
        this.btnToggleSimulation.addEventListener('click', () => {
          this.toggleSimulation();
        });
      }

      if (this.btnGenerateFootprints) {
        this.btnGenerateFootprints.addEventListener('click', () => {
          this.generateFootprintsInsideActiveFences();
        });
      }

      if (this.btnRefreshFootprints) {
        this.btnRefreshFootprints.addEventListener('click', () => {
          this.loadRecentFootprintsFromBackend();
        });
      }

      if (this.btnClearFootprints) {
        this.btnClearFootprints.addEventListener('click', () => {
          this.clearAllFootprints();
        });
      }

      if (this.btnCreateSampleFences) {
        this.btnCreateSampleFences.addEventListener('click', () => {
          this.createSampleDemoGeofences();
        });
      }

      if (this.dbStatusBadge) {
        this.dbStatusBadge.addEventListener('click', () => {
          const uri = this.compassUri || 'mongodb://localhost:27017';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(uri).then(() => {
              this.showToast(`📋 Copied MongoDB Compass URI to clipboard:\n${uri}`, 'success');
            }).catch(() => {
              this.showToast(`MongoDB Compass URI: ${uri}`, 'info');
            });
          } else {
            this.showToast(`MongoDB Compass URI: ${uri}`, 'info');
          }
        });
      }

      this.btnFinishPolygon.addEventListener('click', () => {
        if (!this.mapManager.finishPolygon()) {
          this.showToast('Add at least 3 points to complete the polygon', 'warning');
        }
      });

      this.btnClearPolygon.addEventListener('click', () => {
        this.mapManager.clearDraft();
        this.renderPolygonDraftPoints([]);
        this.polygonPointsCount.textContent = '0';
      });

      this.btnSaveGeofence.addEventListener('click', () => {
        this.handleSaveGeofence();
      });

      this.btnCancelGeofence.addEventListener('click', () => {
        this.cancelEditing();
      });

      this.btnClearShape.addEventListener('click', () => {
        this.mapManager.clearDraft();
        this.resetModeFormValues();
      });

      this.savedSearchInput.addEventListener('input', () => {
        this.renderSavedList();
      });

      this.btnCopyCoords.addEventListener('click', () => {
        this.copyCurrentDetailsToClipboard();
      });

      this.btnEditFromDetails.addEventListener('click', () => {
        const selected = this.store.getSelected();
        if (selected) {
          this.startEditGeofence(selected);
        }
      });

      this.btnDeleteFromDetails.addEventListener('click', () => {
        const selected = this.store.getSelected();
        if (selected) {
          this.confirmAction(
            `Delete "${selected.name}"?`,
            `Are you sure you want to delete this geofence? This action cannot be undone.`,
            () => {
              this.store.delete(selected.id);
              this.showToast(`Geofence "${selected.name}" deleted`, 'info');
            }
          );
        }
      });

      this.tileSelect.addEventListener('change', (e) => {
        this.mapManager.setTileLayer(e.target.value);
      });

      this.btnFitAll.addEventListener('click', () => {
        const all = this.store.getAll();
        if (all.length > 0) {
          this.mapManager.fitAll(all);
        } else {
          this.showToast('No saved geofences to fit view to', 'info');
        }
      });

      this.btnLocateMe.addEventListener('click', () => {
        this.btnLocateMe.classList.add('loading');
        this.mapManager
          .locateUser()
          .then((coords) => {
            this.btnLocateMe.classList.remove('loading');
            this.showToast(`Located GPS: ${formatCoord(coords.lat)}, ${formatCoord(coords.lng)}`, 'success');
          })
          .catch((err) => {
            this.btnLocateMe.classList.remove('loading');
            this.showToast(`GPS error: ${err.message}`, 'error');
          });
      });

      let searchDebounce = null;
      this.locationSearchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        const query = e.target.value.trim();
        if (query.length < 3) {
          this.locationSearchResults.classList.add('hidden');
          this.locationSearchResults.innerHTML = '';
          return;
        }

        searchDebounce = setTimeout(() => {
          this.performLocationSearch(query);
        }, 400);
      });

      document.addEventListener('click', (e) => {
        if (!this.locationSearchInput.contains(e.target) && !this.locationSearchResults.contains(e.target)) {
          this.locationSearchResults.classList.add('hidden');
        }
      });

      this.btnExportGeoJSON.addEventListener('click', () => {
        const data = this.store.toGeoJSON();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `geofences_${new Date().toISOString().slice(0, 10)}.geojson`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Exported Geofences as GeoJSON', 'success');
      });

      this.btnImportGeoJSON.addEventListener('click', () => {
        this.fileImportInput.click();
      });

      this.fileImportInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const json = JSON.parse(event.target.result);
            const count = this.store.importGeoJSON(json);
            this.showToast(`Successfully imported ${count} geofences`, 'success');
            this.fileImportInput.value = '';
            this.mapManager.fitAll(this.store.getAll());
          } catch (err) {
            this.showToast(`Import error: ${err.message}`, 'error');
          }
        };
        reader.readAsText(file);
      });

      this.btnClearAllFences.addEventListener('click', () => {
        if (this.store.getAll().length === 0) {
          this.showToast('No geofences to clear', 'info');
          return;
        }
        this.confirmAction(
          'Clear All Geofences?',
          'This will permanently delete all geofences from the map and local storage.',
          () => {
            this.store.clearAll();
            this.mapManager.clearDraft();
            this.showToast('All geofences cleared', 'info');
          }
        );
      });

      this.confirmBtnOk.addEventListener('click', () => {
        if (this.onConfirmCallback) {
          this.onConfirmCallback();
        }
        this.closeConfirmModal();
      });

      this.confirmBtnCancel.addEventListener('click', () => {
        this.closeConfirmModal();
      });
    }

    bindStoreEvents() {
      this.store.on('store:changed', () => {
        this.renderSavedList();
        this.mapManager.renderSavedGeofences(this.store.getAll(), this.store.selectedGeofenceId);
      });

      this.store.on('selection:changed', (selected) => {
        this.updateDetailsPanel(selected);
        this.renderSavedList();
        this.mapManager.renderSavedGeofences(this.store.getAll(), this.store.selectedGeofenceId);

        if (selected && !this.editingGeofence) {
          this.mapManager.zoomToGeofence(selected);
        }
      });

      this.mapManager.renderSavedGeofences(this.store.getAll(), this.store.selectedGeofenceId);
      if (this.store.getSelected()) {
        this.updateDetailsPanel(this.store.getSelected());
      }
    }

    enterAddMode(shape = null) {
      this.isAddMode = true;
      if (this.btnStartAdd) {
        this.btnStartAdd.classList.remove('btn-secondary');
        this.btnStartAdd.classList.add('btn-primary');
      }
      if (this.btnExploreMode) {
        this.btnExploreMode.classList.remove('btn-primary');
        this.btnExploreMode.classList.add('btn-secondary');
      }
      if (this.modeSelectorSection) {
        this.modeSelectorSection.classList.remove('hidden');
      }
      if (this.formCard) {
        this.formCard.classList.remove('hidden');
      }

      const targetShape = shape || this.currentMode || GeofenceType.CIRCLE;
      this.switchMode(targetShape);
      this.showToast(`Draw Mode: Click on map to place your ${targetShape}.`, 'info');
    }

    enterExploreMode(shouldClearDraft = true) {
      this.isAddMode = false;
      this.editingGeofence = null;
      this.mapManager.editingGeofenceId = null;

      if (this.btnStartAdd) {
        this.btnStartAdd.classList.remove('btn-primary');
        this.btnStartAdd.classList.add('btn-secondary');
      }
      if (this.btnExploreMode) {
        this.btnExploreMode.classList.remove('btn-secondary');
        this.btnExploreMode.classList.add('btn-primary');
      }

      if (shouldClearDraft) {
        this.mapManager.cancelDrawing();
        this.resetModeFormValues();
      } else {
        this.mapManager.setDrawingMode(DrawingMode.IDLE);
        this.mapManager.clearDraft();
      }

      if (this.drawingInstruction) {
        this.drawingInstruction.textContent = '🧭 Explore Mode: Click any geofence to inspect details. Click "+ Add Geofence" when needed.';
      }
      if (this.formTitle) {
        this.formTitle.textContent = 'Geofence Parameters';
      }
      if (this.btnSaveGeofence) {
        this.btnSaveGeofence.innerHTML = `<span class="icon">+</span> Save Geofence`;
      }
      if (this.btnCancelGeofence) {
        this.btnCancelGeofence.classList.add('hidden');
      }

      this.mapManager.renderSavedGeofences(this.store.getAll(), this.store.selectedGeofenceId);
      const selected = this.store.getSelected();
      if (selected) {
        this.updateDetailsPanel(selected);
      }
    }

    switchMode(mode) {
      this.currentMode = mode;

      this.modeButtons.forEach((btn) => {
        if (btn.dataset.mode === mode) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      Object.keys(this.modeSections).forEach((key) => {
        if (this.modeSections[key]) {
          if (key === mode) {
            this.modeSections[key].classList.remove('hidden');
          } else {
            this.modeSections[key].classList.add('hidden');
          }
        }
      });

      const instructions = {
        [GeofenceType.CIRCLE]: 'Click any location on the map to place circle center, then drag the radius handle to resize.',
        [GeofenceType.RECTANGLE]: 'Click Corner 1 on the map, then move cursor and click Corner 2 to complete the rectangle.',
        [GeofenceType.POLYGON]: 'Click on the map to add vertices (Point 1 → Point 2 → ...). Click Point 1 or "Finish" when done.'
      };
      this.drawingInstruction.textContent = instructions[mode] || '';

      this.mapManager.setDrawingMode(mode);
      this.resetModeFormValues();
    }

    resetModeFormValues() {
      this.inputCircleLat.value = '';
      this.inputCircleLng.value = '';
      this.inputCircleRadius.value = '200';
      this.sliderCircleRadius.value = '200';

      this.inputRectNorth.value = '';
      this.inputRectSouth.value = '';
      this.inputRectEast.value = '';
      this.inputRectWest.value = '';

      this.polygonPointsCount.textContent = '0';
      this.polygonPointsList.innerHTML = '<div class="empty-hint">No vertices added yet. Click map to add.</div>';

    }

    handleDraftChange(draft) {
      this.activeDraftPayload = draft;

      if (!draft) {
        if (this.store.getSelected()) {
          this.updateDetailsPanel(this.store.getSelected());
        } else {
          this.showDetailsEmptyState();
        }
        return;
      }

      if (draft.type === GeofenceType.CIRCLE && draft.coordinates) {
        this.inputCircleLat.value = formatCoord(draft.coordinates.lat);
        this.inputCircleLng.value = formatCoord(draft.coordinates.lng);
        this.inputCircleRadius.value = Math.round(draft.radius);
        this.sliderCircleRadius.value = Math.min(3000, Math.round(draft.radius));
      } else if (draft.type === GeofenceType.RECTANGLE && draft.coordinates) {
        this.inputRectNorth.value = formatCoord(draft.coordinates.north);
        this.inputRectSouth.value = formatCoord(draft.coordinates.south);
        this.inputRectEast.value = formatCoord(draft.coordinates.east);
        this.inputRectWest.value = formatCoord(draft.coordinates.west);
      } else if (draft.type === GeofenceType.POLYGON) {
        this.polygonPointsCount.textContent = draft.coordinates.length;
        this.renderPolygonDraftPoints(draft.coordinates);
      }

      this.renderCoordinatePanelFromDraft(draft);
    }

    renderPolygonDraftPoints(points) {
      if (!points || points.length === 0) {
        this.polygonPointsList.innerHTML = '<div class="empty-hint">No vertices added yet. Click map to add.</div>';
        return;
      }

      this.polygonPointsList.innerHTML = points
        .map(
          (pt, idx) => `
          <div class="polygon-pt-row">
            <span class="pt-idx">#${idx + 1}</span>
            <span class="pt-coord">${formatCoord(pt[0])}, ${formatCoord(pt[1])}</span>
            <button type="button" class="btn-del-pt" data-pt-idx="${idx}" title="Remove vertex">&times;</button>
          </div>
        `
        )
        .join('');

      this.polygonPointsList.querySelectorAll('.btn-del-pt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = Number(btn.dataset.ptIdx);
          this.mapManager.deletePolygonPoint(idx);
        });
      });
    }

    renderCoordinatePanelFromDraft(draft) {
      this.detailsEmptyState.classList.add('hidden');
      this.detailsContent.classList.remove('hidden');

      this.btnEditFromDetails.classList.add('hidden');
      this.btnDeleteFromDetails.classList.add('hidden');

      let html = '';

      if (draft.type === GeofenceType.CIRCLE) {
        html = `
          <div class="details-grid circle-view">
            <div class="details-section-title">
              <span class="badge-type circle">CIRCLE (DRAFT)</span>
            </div>

            <div class="coord-block">
              <div class="coord-label">Center Latitude</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.lat)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Center Longitude</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.lng)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Radius</div>
              <div class="coord-value highlight">${formatDistance(draft.radius)}</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value">${formatArea(draft.area)}</div>
            </div>

            <div class="coord-block full-width">
              <div class="coord-label">Circumference</div>
              <div class="coord-value">${formatDistance(draft.circumference)}</div>
            </div>
          </div>
        `;
      } else if (draft.type === GeofenceType.RECTANGLE) {
        html = `
          <div class="details-grid rect-view">
            <div class="details-section-title">
              <span class="badge-type rectangle">RECTANGLE (DRAFT)</span>
            </div>

            <div class="coord-block">
              <div class="coord-label">North (Max Lat)</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.north)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">South (Min Lat)</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.south)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">East (Max Lng)</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.east)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">West (Min Lng)</div>
              <div class="coord-value monospace">${formatCoord(draft.coordinates.west)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Dimensions</div>
              <div class="coord-value">${formatDistance(draft.widthMeters)} &times; ${formatDistance(draft.heightMeters)}</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value highlight">${formatArea(draft.areaMeters)}</div>
            </div>
          </div>
        `;
      } else if (draft.type === GeofenceType.POLYGON) {
        const pointsListHtml = (draft.coordinates || [])
          .map(
            (pt, i) => `
            <div class="details-poly-item">
              <span class="poly-index">${i + 1}.</span>
              <span class="poly-coords monospace">${formatCoord(pt[0])}, ${formatCoord(pt[1])}</span>
            </div>
          `
          )
          .join('');

        html = `
          <div class="details-grid poly-view">
            <div class="details-section-title">
              <span class="badge-type polygon">POLYGON (DRAFT)</span>
              <span class="badge-meta">${draft.coordinates.length} Vertices</span>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Perimeter</div>
              <div class="coord-value">${formatDistance(draft.perimeter)}</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value highlight">${formatArea(draft.area)}</div>
            </div>

            <div class="coord-block full-width">
              <div class="coord-label">Vertices (Latitude, Longitude)</div>
              <div class="details-poly-list">
                ${pointsListHtml || '<div class="empty-hint">Click on map to add points</div>'}
              </div>
            </div>
          </div>
        `;
      }

      this.detailsContent.innerHTML = html;
    }

    updateDetailsPanel(geofence) {
      if (!geofence) {
        this.showDetailsEmptyState();
        return;
      }

      this.detailsEmptyState.classList.add('hidden');
      this.detailsContent.classList.remove('hidden');

      this.btnEditFromDetails.classList.remove('hidden');
      this.btnDeleteFromDetails.classList.remove('hidden');

      let contentHtml = '';

      if (geofence.type === GeofenceType.CIRCLE) {
        const metrics = getCircleMetrics(geofence.radius);
        contentHtml = `
          <div class="details-header-card">
            <div class="details-title-row">
              <div class="name-chip">
                <span class="color-dot" style="background-color: ${geofence.color}"></span>
                <h3 class="fence-title">${geofence.name}</h3>
              </div>
              <div class="badge-group">
                <span class="badge-type circle">CIRCLE</span>
                <span class="badge-status ${geofence.status}">${geofence.status.toUpperCase()}</span>
              </div>
            </div>
            ${geofence.description ? `<p class="fence-desc-text">${geofence.description}</p>` : ''}
          </div>

          <div class="details-grid circle-view">
            <div class="coord-block">
              <div class="coord-label">Center Latitude</div>
              <div class="coord-value monospace">${formatCoord(geofence.coordinates.lat)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Center Longitude</div>
              <div class="coord-value monospace">${formatCoord(geofence.coordinates.lng)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Radius</div>
              <div class="coord-value highlight">${formatDistance(geofence.radius)}</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value">${formatArea(metrics.area)}</div>
            </div>

            <div class="coord-block full-width">
              <div class="coord-label">Circumference</div>
              <div class="coord-value">${formatDistance(metrics.circumference)}</div>
            </div>

            <div class="coord-block full-width meta-timestamp">
              <span class="meta-label">ID: <code class="monospace">${geofence.id}</code></span>
              <span class="meta-label">Created: ${new Date(geofence.created_at).toLocaleString()}</span>
            </div>
          </div>
        `;
      } else if (geofence.type === GeofenceType.RECTANGLE) {
        const { north, south, east, west } = geofence.coordinates;
        const metrics = getRectangleMetrics(north, south, east, west);

        contentHtml = `
          <div class="details-header-card">
            <div class="details-title-row">
              <div class="name-chip">
                <span class="color-dot" style="background-color: ${geofence.color}"></span>
                <h3 class="fence-title">${geofence.name}</h3>
              </div>
              <div class="badge-group">
                <span class="badge-type rectangle">RECTANGLE</span>
                <span class="badge-status ${geofence.status}">${geofence.status.toUpperCase()}</span>
              </div>
            </div>
            ${geofence.description ? `<p class="fence-desc-text">${geofence.description}</p>` : ''}
          </div>

          <div class="details-grid rect-view">
            <div class="coord-block">
              <div class="coord-label">North (Max Latitude)</div>
              <div class="coord-value monospace">${formatCoord(north)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">South (Min Latitude)</div>
              <div class="coord-value monospace">${formatCoord(south)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">East (Max Longitude)</div>
              <div class="coord-value monospace">${formatCoord(east)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">West (Min Longitude)</div>
              <div class="coord-value monospace">${formatCoord(west)}°</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Dimensions</div>
              <div class="coord-value">${formatDistance(metrics.widthMeters)} &times; ${formatDistance(metrics.heightMeters)}</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value highlight">${formatArea(metrics.areaMeters)}</div>
            </div>

            <div class="coord-block full-width meta-timestamp">
              <span class="meta-label">ID: <code class="monospace">${geofence.id}</code></span>
              <span class="meta-label">Created: ${new Date(geofence.created_at).toLocaleString()}</span>
            </div>
          </div>
        `;
      } else if (geofence.type === GeofenceType.POLYGON) {
        const area = calculatePolygonArea(geofence.coordinates);
        const perimeter = calculatePolygonPerimeter(geofence.coordinates);

        const pointsListHtml = (geofence.coordinates || [])
          .map(
            (pt, i) => `
            <div class="details-poly-item">
              <span class="poly-index">${i + 1}.</span>
              <span class="poly-coords monospace">${formatCoord(pt[0])}, ${formatCoord(pt[1])}</span>
            </div>
          `
          )
          .join('');

        contentHtml = `
          <div class="details-header-card">
            <div class="details-title-row">
              <div class="name-chip">
                <span class="color-dot" style="background-color: ${geofence.color}"></span>
                <h3 class="fence-title">${geofence.name}</h3>
              </div>
              <div class="badge-group">
                <span class="badge-type polygon">POLYGON</span>
                <span class="badge-status ${geofence.status}">${geofence.status.toUpperCase()}</span>
              </div>
            </div>
            ${geofence.description ? `<p class="fence-desc-text">${geofence.description}</p>` : ''}
          </div>

          <div class="details-grid poly-view">
            <div class="coord-block">
              <div class="coord-label">Total Vertices</div>
              <div class="coord-value">${geofence.coordinates.length} points</div>
            </div>

            <div class="coord-block">
              <div class="coord-label">Total Area</div>
              <div class="coord-value highlight">${formatArea(area)}</div>
            </div>

            <div class="coord-block full-width">
              <div class="coord-label">Perimeter Distance</div>
              <div class="coord-value">${formatDistance(perimeter)}</div>
            </div>

            <div class="coord-block full-width">
              <div class="coord-label">Points (Latitude, Longitude)</div>
              <div class="details-poly-list">
                ${pointsListHtml}
              </div>
            </div>

            <div class="coord-block full-width meta-timestamp">
              <span class="meta-label">ID: <code class="monospace">${geofence.id}</code></span>
              <span class="meta-label">Created: ${new Date(geofence.created_at).toLocaleString()}</span>
            </div>
          </div>
        `;
      }

      this.detailsContent.innerHTML = contentHtml;
    }

    showDetailsEmptyState() {
      this.detailsEmptyState.classList.remove('hidden');
      this.detailsContent.classList.add('hidden');
      this.btnEditFromDetails.classList.add('hidden');
      this.btnDeleteFromDetails.classList.add('hidden');
    }

    syncInputsToDraft() {
      if (this.currentMode === GeofenceType.CIRCLE) {
        const lat = parseFloat(this.inputCircleLat.value);
        const lng = parseFloat(this.inputCircleLng.value);
        const radius = parseFloat(this.inputCircleRadius.value) || 200;
        if (!isNaN(lat) && !isNaN(lng)) {
          this.mapManager.setCircleCenter(lat, lng, radius);
        }
      } else if (this.currentMode === GeofenceType.RECTANGLE) {
        const n = parseFloat(this.inputRectNorth.value);
        const s = parseFloat(this.inputRectSouth.value);
        const e = parseFloat(this.inputRectEast.value);
        const w = parseFloat(this.inputRectWest.value);
        if (!isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w) && n > s && e > w) {
          this.mapManager.setRectangleBounds(n, s, e, w);
        }
      }
    }

    handleSaveGeofence() {
      this.syncInputsToDraft();

      const draft = this.activeDraftPayload;
      if (!draft || !draft.isValid) {
        if (this.currentMode === GeofenceType.CIRCLE) {
          this.showToast('Please click on the map to set circle center first', 'warning');
        } else if (this.currentMode === GeofenceType.RECTANGLE) {
          this.showToast('Please define opposite corners on the map for the rectangle', 'warning');
        } else if (this.currentMode === GeofenceType.POLYGON) {
          this.showToast('Please add at least 3 points to complete the polygon', 'warning');
        }
        return;
      }

      const name = this.inputFenceName.value.trim() || `Geofence ${this.store.getAll().length + 1}`;
      const description = this.inputFenceDesc.value.trim();
      const status = this.inputFenceStatus.checked ? GeofenceStatus.ACTIVE : GeofenceStatus.DISABLED;

      let selectedColor = '#2563eb';
      this.colorRadios.forEach((r) => {
        if (r.checked) selectedColor = r.value;
      });

      const isEditing = !!this.editingGeofence;
      const targetId = isEditing ? this.editingGeofence.id : null;

      // CRITICAL: Clear editing flags BEFORE updating store so renderSavedGeofences will include this geofence!
      this.editingGeofence = null;
      this.mapManager.editingGeofenceId = null;
      this.mapManager.clearDraft();

      let savedFence = null;
      if (isEditing && targetId) {
        savedFence = this.store.update(targetId, {
          name,
          type: draft.type,
          coordinates: draft.coordinates,
          radius: (draft.type === GeofenceType.CIRCLE) ? Number(draft.radius) || 200 : undefined,
          status,
          color: selectedColor,
          description
        });
        this.showToast(`Updated geofence "${savedFence.name}"`, 'success');
      } else {
        savedFence = this.store.add({
          name,
          type: draft.type,
          coordinates: draft.coordinates,
          radius: (draft.type === GeofenceType.CIRCLE) ? Number(draft.radius) || 200 : undefined,
          status,
          color: selectedColor,
          description
        });
        this.showToast(`Created geofence "${savedFence.name}"`, 'success');
      }

      if (savedFence) {
        this.store.setSelected(savedFence.id);
        this.mapManager.renderSavedGeofences(this.store.getAll(), savedFence.id);
        this.mapManager.zoomToGeofence(savedFence);
        this.updateDetailsPanel(savedFence);
      }

      this.enterExploreMode(false);
    }

    startEditGeofence(geofence) {
      this.enterAddMode(geofence.type);
      this.editingGeofence = geofence;
      this.formTitle.textContent = `Edit: ${geofence.name}`;
      this.btnSaveGeofence.innerHTML = `<span class="icon">&#10003;</span> Update Geofence`;
      this.btnCancelGeofence.classList.remove('hidden');

      this.inputFenceName.value = geofence.name;
      this.inputFenceDesc.value = geofence.description || '';
      this.inputFenceStatus.checked = geofence.status === GeofenceStatus.ACTIVE;

      this.colorRadios.forEach((r) => {
        r.checked = r.value === geofence.color;
      });

      this.switchMode(geofence.type);
      this.mapManager.loadGeofenceIntoEdit(geofence);
      this.mapManager.renderSavedGeofences(this.store.getAll(), geofence.id);
    }

    cancelEditing() {
      this.enterExploreMode(true);
    }

    renderSavedList() {
      const filter = (this.savedSearchInput.value || '').toLowerCase().trim();
      const all = this.store.getAll();
      const filtered = all.filter(
        (f) =>
          f.name.toLowerCase().includes(filter) ||
          f.type.toLowerCase().includes(filter) ||
          (f.description && f.description.toLowerCase().includes(filter))
      );

      this.savedCountBadge.textContent = `${all.length}`;

      if (filtered.length === 0) {
        this.savedListContainer.innerHTML = `
          <div class="empty-list-state">
            <p>${all.length === 0 ? 'No geofences created yet' : 'No matching geofences found'}</p>
          </div>
        `;
        return;
      }

      const selectedId = this.store.selectedGeofenceId;

      this.savedListContainer.innerHTML = filtered
        .map((fence) => {
          const isSelected = fence.id === selectedId;
          const isActive = fence.status === GeofenceStatus.ACTIVE;

          let coordSummary = '';
          if (fence.type === GeofenceType.CIRCLE) {
            coordSummary = `Center: ${formatCoord(fence.coordinates.lat)}, ${formatCoord(fence.coordinates.lng)} &bull; ${formatDistance(fence.radius)}`;
          } else if (fence.type === GeofenceType.RECTANGLE) {
            coordSummary = `N: ${formatCoord(fence.coordinates.north)}, S: ${formatCoord(fence.coordinates.south)}`;
          } else if (fence.type === GeofenceType.POLYGON) {
            coordSummary = `${fence.coordinates.length} points`;
          }

          return `
            <div class="saved-fence-card ${isSelected ? 'selected' : ''} ${!isActive ? 'disabled' : ''}" data-fence-id="${fence.id}">
              <div class="card-main">
                <div class="card-header">
                  <div class="card-title-group">
                    <span class="color-badge" style="background-color: ${fence.color}"></span>
                    <span class="card-title">${fence.name}</span>
                  </div>
                  <div class="card-badges">
                    <span class="badge-type ${fence.type}">${fence.type.toUpperCase()}</span>
                  </div>
                </div>

                <div class="card-coords">${coordSummary}</div>
              </div>

              <div class="card-actions">
                <label class="toggle-switch-sm" title="${isActive ? 'Disable geofence' : 'Enable geofence'}">
                  <input type="checkbox" class="toggle-status-checkbox" data-fence-id="${fence.id}" ${isActive ? 'checked' : ''}>
                  <span class="slider round"></span>
                </label>

                <button type="button" class="btn-card-action btn-focus-fence" data-fence-id="${fence.id}" title="Focus on map">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="22" y1="12" x2="18" y2="12"></line>
                    <line x1="6" y1="12" x2="2" y2="12"></line>
                    <line x1="12" y1="6" x2="12" y2="2"></line>
                    <line x1="12" y1="22" x2="12" y2="18"></line>
                  </svg>
                </button>

                <button type="button" class="btn-card-action btn-edit-fence" data-fence-id="${fence.id}" title="Edit geofence">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                  </svg>
                </button>

                <button type="button" class="btn-card-action btn-delete-fence" data-fence-id="${fence.id}" title="Delete geofence">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      this.savedListContainer.querySelectorAll('.saved-fence-card').forEach((card) => {
        const id = card.dataset.fenceId;
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-actions')) return;
          this.store.setSelected(id);
        });
      });

      this.savedListContainer.querySelectorAll('.toggle-status-checkbox').forEach((chk) => {
        chk.addEventListener('change', (e) => {
          e.stopPropagation();
          const id = chk.dataset.fenceId;
          const updated = this.store.toggleStatus(id);
          if (updated) {
            this.showToast(`Geofence "${updated.name}" is now ${updated.status}`, 'info');
          }
        });
      });

      this.savedListContainer.querySelectorAll('.btn-focus-fence').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.fenceId;
          this.store.setSelected(id);
          const fence = this.store.getById(id);
          if (fence) this.mapManager.zoomToGeofence(fence);
        });
      });

      this.savedListContainer.querySelectorAll('.btn-edit-fence').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.fenceId;
          const fence = this.store.getById(id);
          if (fence) this.startEditGeofence(fence);
        });
      });

      this.savedListContainer.querySelectorAll('.btn-delete-fence').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.fenceId;
          const fence = this.store.getById(id);
          if (fence) {
            this.confirmAction(
              `Delete "${fence.name}"?`,
              `Are you sure you want to delete this geofence?`,
              () => {
                this.store.delete(id);
                this.showToast(`Deleted "${fence.name}"`, 'info');
              }
            );
          }
        });
      });
    }

    updateCursorHUD(latlng) {
      if (!latlng) {
        this.hudCursor.innerHTML = `<span class="hud-label">Cursor:</span> <span class="hud-val muted">Moving over map...</span>`;
        return;
      }
      const latFormatted = `${formatCoord(latlng.lat)}° ${latlng.lat >= 0 ? 'N' : 'S'}`;
      const lngFormatted = `${formatCoord(latlng.lng)}° ${latlng.lng >= 0 ? 'E' : 'W'}`;
      this.hudCursor.innerHTML = `
        <span class="hud-label">Cursor:</span>
        <span class="hud-val monospace">${latFormatted}, ${lngFormatted}</span>
      `;
    }

    updateMapCenterHUD({ centerLat, centerLng, zoom }) {
      const latFormatted = `${formatCoord(centerLat)}° ${centerLat >= 0 ? 'N' : 'S'}`;
      const lngFormatted = `${formatCoord(centerLng)}° ${centerLng >= 0 ? 'E' : 'W'}`;
      this.hudCenter.innerHTML = `
        <span class="hud-label">Center:</span>
        <span class="hud-val monospace">${latFormatted}, ${lngFormatted}</span>
      `;
      this.hudZoom.innerHTML = `
        <span class="hud-label">Zoom:</span>
        <span class="hud-val monospace">${zoom}</span>
      `;
    }

    copyCurrentDetailsToClipboard() {
      const selected = this.store.getSelected();
      const draft = this.activeDraftPayload;
      const target = selected || draft;

      if (!target) {
        this.showToast('No active geofence to copy', 'warning');
        return;
      }

      let text = '';
      if (target.type === GeofenceType.CIRCLE) {
        const coords = target.coordinates;
        text = `GEOFENCE DETAILS\nType: Circle\nCenter Latitude: ${formatCoord(coords.lat)}\nCenter Longitude: ${formatCoord(coords.lng)}\nRadius: ${Math.round(target.radius)} m`;
      } else if (target.type === GeofenceType.RECTANGLE) {
        const coords = target.coordinates;
        text = `GEOFENCE DETAILS\nType: Rectangle\nNorth: ${formatCoord(coords.north)}\nSouth: ${formatCoord(coords.south)}\nEast: ${formatCoord(coords.east)}\nWest: ${formatCoord(coords.west)}`;
      } else if (target.type === GeofenceType.POLYGON) {
        const pts = target.coordinates || [];
        const lines = pts.map((p, i) => `${i + 1}. ${formatCoord(p[0])}, ${formatCoord(p[1])}`).join('\n');
        text = `GEOFENCE DETAILS\nType: Polygon\nPoints:\n${lines}`;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            this.showToast('Geofence coordinates copied to clipboard!', 'success');
          })
          .catch(() => {
            window.prompt('Copy geofence coordinates:', text);
          });
      } else {
        window.prompt('Copy geofence coordinates:', text);
      }
    }

    async performLocationSearch(query) {
      try {
        this.locationSearchResults.innerHTML = '<div class="search-item loading">Searching locations...</div>';
        this.locationSearchResults.classList.remove('hidden');

        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const items = await res.json();

        if (!items || items.length === 0) {
          this.locationSearchResults.innerHTML = '<div class="search-item empty">No locations found</div>';
          return;
        }

        this.locationSearchResults.innerHTML = items
          .map(
            (item) => `
            <div class="search-item" data-lat="${item.lat}" data-lon="${item.lon}">
              <div class="search-item-title">${item.display_name.split(',')[0]}</div>
              <div class="search-item-sub">${item.display_name}</div>
            </div>
          `
          )
          .join('');

        this.locationSearchResults.querySelectorAll('.search-item').forEach((el) => {
          el.addEventListener('click', () => {
            const lat = parseFloat(el.dataset.lat);
            const lon = parseFloat(el.dataset.lon);
            this.mapManager.panToLocation(lat, lon, 15);
            this.locationSearchResults.classList.add('hidden');
            this.locationSearchInput.value = el.querySelector('.search-item-title').textContent;
          });
        });
      } catch (e) {
        this.locationSearchResults.innerHTML = '<div class="search-item empty">Search error, try again</div>';
      }
    }

    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      const icon = type === 'success' ? '&#10003;' : type === 'warning' ? '&#9888;' : type === 'error' ? '&#9888;' : '&#8505;';
      toast.innerHTML = `<span class="toast-icon">${icon}</span> <span class="toast-msg">${message}</span>`;
      this.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 400);
      }, 3500);
    }

    // ==========================================================================
    // AREA SIMULATION, FOOTPRINTS & MOUSE CROSS-FENCE FLAG ENGINE
    // ==========================================================================

    handleFlagGenerated(eventData) {
      if (this.hudFlagCount) {
        this.hudFlagCount.textContent = this.mapManager.flagCount;
      }

      const isEnter = eventData.event === 'ENTER';
      const eventTitle = isEnter ? 'ENTERED' : 'EXITED';
      this.showToast(`🚩 Flag Generated: Mouse ${eventTitle} "${eventData.fence.name}"`, isEnter ? 'success' : 'warning');

      // Record to MongoDB simulation_data_db.simulation_footprints
      fetch('/api/footprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: 'MOUSE_POINTER',
          geofence_id: eventData.fence.id,
          geofence_name: eventData.fence.name,
          latitude: eventData.latlng.lat,
          longitude: eventData.latlng.lng,
          event: eventData.event,
          color: eventData.fence.color,
          source: 'mouse_cross_fence'
        })
      })
      .then(res => res.json())
      .then(data => {
        this.addFootprintToLogUI({ ...data, color: eventData.fence.color });
      })
      .catch(err => {
        console.warn('Telemetry footprint error:', err);
      });
    }

    handleMouseTelemetry(eventData) {
      const fence = eventData.fence;
      const deviceId = eventData.isClick ? 'MOUSE_CLICK' : 'MOUSE_POINTER';
      const source = eventData.isClick ? 'mouse_map_click' : 'mouse_live_telemetry';
      const fenceId = fence ? fence.id : null;
      const fenceName = fence ? fence.name : 'Free Navigation Zone';
      const color = (fence && fence.color) || '#3b82f6';

      // Send live mouse coordinates directly to MongoDB
      fetch('/api/footprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          geofence_id: fenceId,
          geofence_name: fenceName,
          latitude: eventData.latlng.lat,
          longitude: eventData.latlng.lng,
          event: eventData.event || 'INSIDE',
          color: color,
          source: source
        })
      })
      .then(res => res.json())
      .then(data => {
        this.addFootprintToLogUI({ ...data, color });
        if (this.mapManager && this.mapManager.showFootprintsOnMap) {
          this.mapManager.renderFootprintPoint([eventData.latlng.lat, eventData.latlng.lng], {
            device: deviceId,
            fenceName: fenceName,
            color: color,
            fenceColor: color
          });
        }
      })
      .catch(() => {});
    }

    updateMouseFenceHUD(fenceName, isInside) {
      if (!this.hudMouseFence) return;
      if (isInside && fenceName) {
        this.hudMouseFence.innerHTML = `<span style="color:#10b981; font-weight:600;">🟢 Inside "${this.escapeHtml(fenceName)}"</span>`;
      } else {
        this.hudMouseFence.innerHTML = '<span style="color:var(--text-muted);">Outside Fences</span>';
      }
    }

    addFootprintToLogUI(entry) {
      if (!this.footprintsLogList) return;
      const emptyHint = this.footprintsLogList.querySelector('.empty-hint');
      if (emptyHint) emptyHint.remove();

      let allottedColor = entry.color;
      if (!allottedColor && entry.geofence_id) {
        const f = this.store.getById(entry.geofence_id);
        if (f) allottedColor = f.color;
      }
      if (!allottedColor && entry.geofence_name) {
        const f = this.store.getAll().find(x => x.name === entry.geofence_name);
        if (f) allottedColor = f.color;
      }
      if (!allottedColor) allottedColor = '#2563eb';

      const timeStr = entry.created_at ? new Date(entry.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
      const ev = (entry.event || 'INSIDE').toUpperCase();
      const eventClass = ev.toLowerCase();
      const flagEmoji = (ev === 'ENTER' || ev === 'EXIT') ? '🚩 ' : '👣 ';

      const isDummy = entry.database === 'dummy_data_db' || entry.collection === 'dummy_footprints' || entry.source === 'area_dummy_generator' || String(entry.source || '').toLowerCase().includes('dummy');
      const dbBadgeClass = isDummy ? 'db-tag-dummy' : 'db-tag-sim';
      const dbBadgeText = isDummy ? 'DUMMY DB' : 'SIM DB';
      const dbBadgeTitle = isDummy ? 'Stored in dummy_data_db (dummy_footprints collection)' : 'Stored in simulation_data_db (simulation_footprints collection)';

      const item = document.createElement('div');
      item.className = 'footprint-log-item';
      item.style.borderLeftColor = allottedColor;
      item.innerHTML = `
        <div class="log-meta">
          <span class="log-time">${timeStr}</span>
          <span class="log-badge ${eventClass}">${flagEmoji}${ev}</span>
          <span class="log-db-pill ${dbBadgeClass}" title="${dbBadgeTitle}">${dbBadgeText}</span>
          <span class="log-target">
            <span class="log-color-pip" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${allottedColor};box-shadow:0 0 4px ${allottedColor};margin-right:4px;"></span>
            ${this.escapeHtml(entry.device_id || 'TARGET')}
          </span>
        </div>
        <div class="log-fence" title="${this.escapeHtml(entry.geofence_name || 'N/A')}">
          ${this.escapeHtml(entry.geofence_name || 'Active Area')}
        </div>
      `;

      this.footprintsLogList.prepend(item);

      while (this.footprintsLogList.children.length > 40) {
        this.footprintsLogList.removeChild(this.footprintsLogList.lastChild);
      }

      this.totalLoggedCount = (this.totalLoggedCount || 0) + 1;
      if (this.footprintCountBadge) {
        this.footprintCountBadge.textContent = this.totalLoggedCount;
      }
    }

    loadRecentFootprintsFromBackend() {
      fetch('/api/footprints?target=simulation&limit=40')
        .then(res => res.json())
        .then(rows => {
          if (Array.isArray(rows)) {
            if (this.footprintsLogList) {
              this.footprintsLogList.innerHTML = '';
            }
            if (rows.length === 0) {
              if (this.footprintsLogList) {
                this.footprintsLogList.innerHTML = '<div class="empty-hint" style="font-size: 0.74rem;">No footprints or flag events yet. Move mouse over fences or click Drop in Area.</div>';
              }
              return;
            }
            // Reverse so prepend puts newest at top
            [...rows].reverse().forEach(r => {
              const fence = this.store.getById(r.geofence_id) || this.store.getAll().find(f => f.name === r.geofence_name);
              const allottedColor = r.color || (fence && fence.color) || '#2563eb';
              const ev = (r.event || 'INSIDE').toUpperCase();

              if (ev === 'ENTER' || ev === 'EXIT') {
                if (this.mapManager && this.mapManager.showFlagsOnMap) {
                  this.mapManager.generateFlagMarker(ev, fence || { name: r.geofence_name, color: allottedColor }, { lat: r.latitude, lng: r.longitude });
                }
              } else {
                if (r.latitude && r.longitude && this.mapManager && this.mapManager.showFootprintsOnMap) {
                  this.mapManager.renderFootprintPoint([r.latitude, r.longitude], {
                    device: r.device_id,
                    fenceName: r.geofence_name,
                    color: allottedColor,
                    fenceColor: allottedColor
                  });
                }
              }
              this.addFootprintToLogUI({ ...r, color: allottedColor });
            });
          }
        })
        .catch(err => {
          console.warn('Could not load footprints from MongoDB:', err);
        });
    }

    generateFootprintsInsideActiveFences() {
      let activeFences = this.store.getActiveGeofences();
      if (!activeFences || activeFences.length === 0) {
        activeFences = this.store.getAll();
      }

      // Fetch generated ENTER, INSIDE, and EXIT events directly from MongoDB
      fetch('/api/simulation/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3, client_fences: activeFences })
      })
      .then(res => res.json())
      .then(points => {
        if (Array.isArray(points) && points.length > 0) {
          let enterCount = 0;
          let insideCount = 0;
          let exitCount = 0;

          points.forEach(fp => {
            const fence = this.store.getById(fp.geofence_id) || (activeFences && activeFences.find(f => f.name === fp.geofence_name || f.id === fp.geofence_id));
            const allottedColor = (fence && fence.color) || fp.color || '#2563eb';
            const ev = (fp.event || 'INSIDE').toUpperCase();

            if (ev === 'ENTER') {
              enterCount++;
              if (this.mapManager && this.mapManager.showFlagsOnMap) {
                this.mapManager.generateFlagMarker('ENTER', fence || { name: fp.geofence_name, color: allottedColor }, { lat: fp.latitude, lng: fp.longitude });
              }
            } else if (ev === 'EXIT') {
              exitCount++;
              if (this.mapManager && this.mapManager.showFlagsOnMap) {
                this.mapManager.generateFlagMarker('EXIT', fence || { name: fp.geofence_name, color: allottedColor }, { lat: fp.latitude, lng: fp.longitude });
              }
            } else {
              insideCount++;
              if (this.mapManager && this.mapManager.showFootprintsOnMap) {
                this.mapManager.renderFootprintPoint([fp.latitude, fp.longitude], {
                  device: fp.device_id,
                  fenceName: fp.geofence_name,
                  color: allottedColor,
                  fenceColor: allottedColor
                });
              }
            }

            this.addFootprintToLogUI({ ...fp, color: allottedColor });
          });

          this.showToast(`👣 Stored ${points.length} events in MongoDB (${enterCount} ENTER, ${insideCount} INSIDE, ${exitCount} EXIT)!`, 'success');
        }
      })
      .catch(err => {
        console.warn('Backend dummy generator error:', err);
      });
    }

    async createSampleDemoGeofences() {
      try {
        const res = await fetch('/api/geofences/sample', { method: 'POST' });
        if (res.ok) {
          const fences = await res.json();
          if (Array.isArray(fences) && fences.length > 0) {
            this.store.geofences = fences;
            this.store.saveToStorage();
            this.store.emit('store:changed', this.store.geofences);
            this.mapManager.renderSavedGeofences(this.store.geofences, fences[0] ? fences[0].id : null);
            this.renderSavedList();
            this.showToast('🎯 Fetched & seeded sample geofences in MongoDB!', 'success');
            return fences;
          }
        }
      } catch (err) {
        console.warn('Sample geofence fetch error:', err);
      }
      return [];
    }

    toggleSimulation() {
      if (this.simulationRunning) {
        this.simulationRunning = false;
        if (this.simulationTimer) clearInterval(this.simulationTimer);
        this.simulationTimer = null;
        if (this.btnSimulationIcon) this.btnSimulationIcon.textContent = '▶';
        if (this.btnSimulationText) this.btnSimulationText.textContent = 'Start Simulation';
        this.showToast('⏸ Asset Simulation Paused.', 'info');
      } else {
        let activeFences = this.store.getActiveGeofences();
        if (!activeFences || activeFences.length === 0) {
          const all = this.store.getAll();
          if (all.length > 0) {
            activeFences = all;
          } else {
            activeFences = this.createSampleDemoGeofences();
          }
        }

        this.simulationRunning = true;
        if (this.btnSimulationIcon) this.btnSimulationIcon.textContent = '⏸';
        if (this.btnSimulationText) this.btnSimulationText.textContent = 'Pause Simulation';
        this.showToast('▶ Live Simulation Started: Assets moving inside fence area.', 'success');

        this.startSimulationLoop();
      }
    }

    startSimulationLoop() {
      if (this.simulationTimer) clearInterval(this.simulationTimer);

      const getFenceStageCoord = (fence, stage, seedAngle) => {
        let coords = fence.coordinates;
        if (typeof coords === 'string') {
          try { coords = JSON.parse(coords); } catch (e) {}
        }
        if (!coords) return null;

        if (fence.type === GeofenceType.CIRCLE) {
          const lat = Number(coords.lat);
          const lng = Number(coords.lng);
          const radius = Number(fence.radius) || 200;
          let r = radius * 0.5;
          let angle = seedAngle;

          if (stage === 0) {
            // ENTER: Boundary edge crossing in
            r = radius * 0.98;
            angle = seedAngle;
          } else if (stage === 1) {
            // INSIDE: Interior waypoint 1
            r = radius * 0.40;
            angle = seedAngle + Math.PI / 4;
          } else if (stage === 2) {
            // INSIDE: Interior waypoint 2
            r = radius * 0.65;
            angle = seedAngle + Math.PI / 2;
          } else {
            // EXIT: Boundary edge crossing out
            r = radius * 1.02;
            angle = seedAngle + Math.PI;
          }
          const dLat = (r * Math.cos(angle)) / 111320.0;
          const dLng = (r * Math.sin(angle)) / (111320.0 * Math.cos((lat * Math.PI) / 180.0));
          return { lat: Number((lat + dLat).toFixed(6)), lng: Number((lng + dLng).toFixed(6)) };
        } else if (fence.type === GeofenceType.RECTANGLE) {
          const n = Number(coords.north);
          const s = Number(coords.south);
          const e = Number(coords.east);
          const w = Number(coords.west);
          const latSpan = n - s;
          const lngSpan = e - w;
          if (stage === 0) {
            // ENTER at west edge
            return { lat: Number((s + latSpan * 0.35).toFixed(6)), lng: Number((w + lngSpan * 0.02).toFixed(6)) };
          } else if (stage === 1) {
            // INSIDE center west
            return { lat: Number((s + latSpan * 0.50).toFixed(6)), lng: Number((w + lngSpan * 0.40).toFixed(6)) };
          } else if (stage === 2) {
            // INSIDE center east
            return { lat: Number((s + latSpan * 0.60).toFixed(6)), lng: Number((w + lngSpan * 0.70).toFixed(6)) };
          } else {
            // EXIT at east edge
            return { lat: Number((s + latSpan * 0.65).toFixed(6)), lng: Number((e + lngSpan * 0.02).toFixed(6)) };
          }
        } else if (fence.type === GeofenceType.POLYGON) {
          const pts = coords;
          if (Array.isArray(pts) && pts.length >= 3) {
            if (stage === 0) {
              return { lat: Number(pts[0][0].toFixed(6)), lng: Number(pts[0][1].toFixed(6)) };
            } else if (stage === 1 || stage === 2) {
              const avgLat = pts.reduce((acc, p) => acc + p[0], 0) / pts.length;
              const avgLng = pts.reduce((acc, p) => acc + p[1], 0) / pts.length;
              return { lat: Number(avgLat.toFixed(6)), lng: Number(avgLng.toFixed(6)) };
            } else {
              const mid = Math.floor(pts.length / 2);
              return { lat: Number(pts[mid][0].toFixed(6)), lng: Number(pts[mid][1].toFixed(6)) };
            }
          }
        }
        return generatePointInsideFence(fence);
      };

      const stepSimulation = () => {
        if (!this.simulationRunning) return;
        const activeFences = this.store.getActiveGeofences();
        if (!activeFences || activeFences.length === 0) return;

        this.simulatedAssets.forEach((asset, idx) => {
          const fence = activeFences[idx % activeFences.length];
          asset.stage = (asset.stage !== undefined) ? (asset.stage + 1) % 4 : idx % 4;

          let ev = 'INSIDE';
          if (asset.stage === 0) {
            ev = 'ENTER';
          } else if (asset.stage === 3) {
            ev = 'EXIT';
          } else {
            ev = 'INSIDE';
          }

          const seedAngle = (idx * (2 * Math.PI / 3)) + ((Date.now() / 25000) % (2 * Math.PI));
          asset.coords = getFenceStageCoord(fence, asset.stage, seedAngle);

          if (asset.coords) {
            const allottedColor = fence.color || asset.color || '#2563eb';
            this.mapManager.updateSimulatedAsset(asset.id, asset.name, asset.coords, asset.color);

            // If boundary crossing (ENTER/EXIT), place radar flag marker on map
            if (ev === 'ENTER' || ev === 'EXIT') {
              if (this.mapManager && this.mapManager.showFlagsOnMap) {
                this.mapManager.generateFlagMarker(ev, fence, asset.coords);
              }
            } else {
              // INSIDE waypoint footprint dot
              if (this.mapManager && this.mapManager.showFootprintsOnMap) {
                this.mapManager.renderFootprintPoint(asset.coords, {
                  device: asset.name,
                  fenceName: fence.name,
                  color: allottedColor,
                  fenceColor: fence.color
                });
              }
            }

            // Post telemetry footprint directly to MongoDB simulation_data_db
            fetch('/api/footprints', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                device_id: asset.name,
                geofence_id: fence.id,
                geofence_name: fence.name,
                latitude: asset.coords.lat,
                longitude: asset.coords.lng,
                event: ev,
                color: allottedColor,
                source: 'simulation_loop'
              })
            })
            .then(res => res.json())
            .then(data => this.addFootprintToLogUI({ ...data, color: allottedColor }))
            .catch(() => {});
          }
        });
      };

      stepSimulation();
      // 5-second simulation refresh rate
      this.simulationTimer = setInterval(stepSimulation, 5000);
    }

    clearAllFootprints() {
      this.mapManager.clearFootprintsOnMap();
      this.mapManager.clearFlagMarkersOnMap();
      this.mapManager.clearSimulatedAssets();
      if (this.footprintsLogList) {
        this.footprintsLogList.innerHTML = '<div class="empty-hint" style="font-size: 0.74rem;">Logs and footprints cleared.</div>';
      }
      if (this.footprintCountBadge) this.footprintCountBadge.textContent = '0';
      if (this.hudFlagCount) this.hudFlagCount.textContent = '0';
      this.totalLoggedCount = 0;

      fetch('/api/footprints', { method: 'DELETE' })
        .then(() => {
          this.showToast('Footprints, Flag Markers, and DB logs cleared.', 'info');
        })
        .catch(err => console.warn('Clear footprints error:', err));
    }

    loadDatabaseStatus() {
      fetch('/api/database/status')
        .then(res => res.json())
        .then(data => {
          if (!this.dbStatusBadge || !this.dbStatusText) return;
          this.compassUri = data.compass_connection_string || data.mongodb_uri || 'mongodb://localhost:27017';
          const simName = data.simulation_database || 'simulation_data_db';
          const dummyName = data.dummy_database || 'dummy_data_db';
          if (data.mongodb_connected) {
            this.dbStatusBadge.classList.add('mongo-active');
            this.dbStatusBadge.classList.remove('sqlite-active');
            this.dbStatusText.textContent = 'MongoDB Atlas (2 DBs)';
            this.dbStatusBadge.title = `MongoDB Compass Connected!\n` +
              `1. Simulation DB (Live data): ${simName} (collections: geofences, simulation_footprints)\n` +
              `2. Dummy DB (Generated): ${dummyName} (collection: dummy_footprints)\n` +
              `URI: ${data.mongodb_uri}\nClick to copy Compass URI`;
          } else {
            this.dbStatusBadge.classList.remove('mongo-active');
            this.dbStatusBadge.classList.add('sqlite-active');
            this.dbStatusText.textContent = 'MongoDB (Connecting...)';
            this.dbStatusBadge.title = `Connecting to MongoDB Atlas / Compass...\n` +
              `1. Simulation DB: ${simName}\n` +
              `2. Dummy DB: ${dummyName}\n` +
              `Target URI: ${this.compassUri}\nClick to copy Compass URI`;
          }
        })
        .catch(() => {});
    }

    confirmAction(title, message, callback) {
      this.confirmTitle.textContent = title;
      this.confirmMessage.textContent = message;
      this.onConfirmCallback = callback;
      this.confirmModal.classList.remove('hidden');
    }

    closeConfirmModal() {
      this.confirmModal.classList.add('hidden');
      this.onConfirmCallback = null;
    }
  }

  /* ==========================================================================
     5. INITIALIZE ON DOM READY
     ========================================================================== */

  function initApp() {
    try {
      const store = new GeofenceStore();
      let uiController = null;

      const mapManager = new MapManager({
        containerId: 'map',
        onCursorMove: (latlng) => {
          if (uiController) uiController.updateCursorHUD(latlng);
        },
        onMapMove: (mapData) => {
          if (uiController) uiController.updateMapCenterHUD(mapData);
        },
        onDraftChange: (draft) => {
          if (uiController) uiController.handleDraftChange(draft);
        },
        onSelectGeofence: (id) => {
          store.setSelected(id);
        },
        onFlagGenerated: (eventData) => {
          if (uiController) uiController.handleFlagGenerated(eventData);
        },
        onMouseTelemetry: (eventData) => {
          if (uiController) uiController.handleMouseTelemetry(eventData);
        },
        onMouseFenceStatusChange: (fenceName, isInside) => {
          if (uiController) uiController.updateMouseFenceHUD(fenceName, isInside);
        }
      });

      uiController = new UIController({
        store,
        mapManager
      });

      window.geofenceApp = { store, mapManager, uiController };
      console.log('Geofence Map Builder initialized successfully.');
    } catch (err) {
      console.error('Fatal initialization error in Geofence Map Builder:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
