"""
Telemetry Service & Persistent Geofence Event Engine
Processes real-time GPS telemetry from mobile phones and external GPS devices:
  1. Validates device status and coordinates
  2. Stores GeoJSON Point [longitude, latitude] into locations collection
  3. Evaluates active geofences using spatial math
  4. Maintains persistent state in device_geofence_state collection
  5. Fires ENTER / EXIT events only on true boundary state transitions
  6. Updates device's last_location, last_seen, and current_fence
"""

import math
import uuid
import json
from datetime import datetime

from services.db import (
    get_tracking_db,
    in_memory_locations,
    in_memory_geofence_events,
    in_memory_device_geofence_state,
    use_mongodb
)
from services.device_service import get_device, update_device, register_device, find_existing_device

EARTH_RADIUS_METERS = 6371008.8

# -----------------------------------------------------------------------------
# SPATIAL MATHEMATICS CORE (Identical to existing geofence engine)
# -----------------------------------------------------------------------------

def haversine_distance(lat1, lon1, lat2, lon2):
    to_rad = lambda a: (a * math.pi) / 180.0
    d_lat = to_rad(lat2 - lat1)
    d_lon = to_rad(lon2 - lon1)
    r_lat1 = to_rad(lat1)
    r_lat2 = to_rad(lat2)

    a = (math.sin(d_lat / 2.0) ** 2 +
         math.cos(r_lat1) * math.cos(r_lat2) * (math.sin(d_lon / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c

def is_point_in_circle(point, center, radius_meters):
    d = haversine_distance(point[0], point[1], center[0], center[1])
    return d <= radius_meters

def is_point_in_rectangle(point, bounds):
    lat, lng = point
    return bounds.get('south', 0) <= lat <= bounds.get('north', 0) and bounds.get('west', 0) <= lng <= bounds.get('east', 0)

def is_point_in_polygon(point, polygon):
    lat, lng = point
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        intersect = ((yi > lng) != (yj > lng)) and (lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi)
        if intersect:
            inside = not inside
        j = i
    return inside

def evaluate_point_against_fence(point, fence):
    """Evaluates (lat, lng) against circle, rectangle, or polygon fence."""
    if fence.get('status') != 'active':
        return False

    ftype = fence.get('type')
    coords = fence.get('coordinates')
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            return False

    if ftype == 'circle':
        center = (coords['lat'], coords['lng'])
        return is_point_in_circle(point, center, float(fence.get('radius', 0)))
    elif ftype == 'rectangle':
        return is_point_in_rectangle(point, coords)
    elif ftype == 'polygon':
        return is_point_in_polygon(point, coords)
    return False

def distance_to_segment(point, p1, p2):
    """Calculates perpendicular or vertex distance in meters from point to line segment (p1->p2)."""
    lat, lng = point
    lat1, lng1 = p1
    lat2, lng2 = p2

    mean_lat_rad = math.radians((lat1 + lat2 + lat) / 3.0)
    kx = 111320.0 * math.cos(mean_lat_rad)
    ky = 110540.0

    px = (lng - lng1) * kx
    py = (lat - lat1) * ky

    sx = (lng2 - lng1) * kx
    sy = (lat2 - lat1) * ky

    seg_len_sq = sx * sx + sy * sy
    if seg_len_sq == 0:
        return haversine_distance(lat, lng, lat1, lng1)

    t = (px * sx + py * sy) / seg_len_sq
    t = max(0.0, min(1.0, t))

    near_lat = lat1 + t * (lat2 - lat1)
    near_lng = lng1 + t * (lng2 - lng1)

    return haversine_distance(lat, lng, near_lat, near_lng)

def distance_to_fence(point, fence) -> float:
    """
    Computes minimum geodesic distance in meters from point (lat, lng) to fence boundary.
    Returns 0.0 if the point is inside the fence.
    """
    ftype = fence.get('type')
    coords = fence.get('coordinates')
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            return float('inf')

    lat, lng = point

    if ftype == 'circle':
        center = (float(coords.get('lat', 0)), float(coords.get('lng', 0)))
        radius = float(fence.get('radius', 0))
        dist_to_center = haversine_distance(lat, lng, center[0], center[1])
        return max(0.0, dist_to_center - radius)

    elif ftype == 'rectangle':
        south = float(coords.get('south', 0))
        north = float(coords.get('north', 0))
        west = float(coords.get('west', 0))
        east = float(coords.get('east', 0))

        if south <= lat <= north and west <= lng <= east:
            return 0.0

        nearest_lat = max(south, min(lat, north))
        nearest_lng = max(west, min(lng, east))
        return haversine_distance(lat, lng, nearest_lat, nearest_lng)

    elif ftype == 'polygon':
        poly_points = []
        if isinstance(coords, list):
            for pt in coords:
                if isinstance(pt, dict):
                    poly_points.append((float(pt.get('lat', 0)), float(pt.get('lng', 0))))
                elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                    poly_points.append((float(pt[0]), float(pt[1])))

        if len(poly_points) < 3:
            return float('inf')

        if is_point_in_polygon(point, poly_points):
            return 0.0

        min_d = float('inf')
        n = len(poly_points)
        for i in range(n):
            p1 = poly_points[i]
            p2 = poly_points[(i + 1) % n]
            d = distance_to_segment(point, p1, p2)
            if d < min_d:
                min_d = d
        return min_d

    return float('inf')

# -----------------------------------------------------------------------------
# PERSISTENT STATE MANAGEMENT (device_geofence_state)
# -----------------------------------------------------------------------------

def get_device_fence_state(device_id: str, fence_id: str) -> bool:
    """Returns True if device is currently recorded as INSIDE the given fence."""
    db = get_tracking_db()
    if db is not None:
        try:
            doc = db.device_geofence_state.find_one(
                {'device_id': device_id, 'geofence_id': fence_id},
                {'_id': 0, 'inside': 1}
            )
            if doc:
                return bool(doc.get('inside', False))
        except Exception:
            pass

    key = f"{device_id}_{fence_id}"
    return in_memory_device_geofence_state.get(key, False)

def set_device_fence_state(device_id: str, fence_id: str, inside: bool):
    """Persists whether device is inside or outside the given fence."""
    now = datetime.utcnow().isoformat() + 'Z'
    key = f"{device_id}_{fence_id}"
    in_memory_device_geofence_state[key] = inside

    db = get_tracking_db()
    if db is not None:
        try:
            db.device_geofence_state.replace_one(
                {'device_id': device_id, 'geofence_id': fence_id},
                {
                    'device_id': device_id,
                    'geofence_id': fence_id,
                    'inside': bool(inside),
                    'last_updated': now
                },
                upsert=True
            )
        except Exception as e:
            print(f">> [MongoDB State Write Error] {e}")

# -----------------------------------------------------------------------------
# TELEMETRY PIPELINE
# -----------------------------------------------------------------------------

def process_telemetry(payload: dict, active_fences: list = None) -> tuple:
    """
    Main Telemetry Processing Pipeline:
      1. Validates device_id, lat, lng, timestamp
      2. Checks device registration and revoked status
      3. Stores GeoJSON Point into locations collection
      4. Detects ENTER / EXIT transitions with persistent state
      5. Updates device metadata
    """
    device_id = str(payload.get('device_id', '')).strip()
    client_uuid = str(payload.get('client_uuid', '')).strip() or None
    fingerprint = str(payload.get('fingerprint', '')).strip() or None
    client_ip = payload.get('client_ip')

    # Verify device exists or reconnect via device_id or client_uuid
    device = get_device(device_id) if device_id else None
    if not device and client_uuid:
        device = find_existing_device(client_uuid=client_uuid)
        if device:
            device_id = device['device_id']

    if not device:
        dev_name = payload.get('device_name') or None
        device, reg_err = register_device(
            device_name=dev_name,
            user_id=payload.get('user_id', 'anon_user'),
            platform=payload.get('platform', 'browser'),
            custom_id=device_id if device_id else None,
            client_uuid=client_uuid,
            fingerprint=fingerprint,
            client_ip=client_ip
        )
        if device:
            device_id = device['device_id']
        elif not device_id:
            device_id = f"DEV_{uuid.uuid4().hex[:6].upper()}"
            device = {
                'device_id': device_id,
                'device_name': dev_name or 'Device 1',
                'platform': 'browser',
                'client_uuid': client_uuid,
                'revoked': False
            }

    if device and device.get('revoked'):
        return None, f"Device '{device_id}' has been revoked by administrator."

    # Validate Latitude & Longitude
    try:
        lat = float(payload.get('latitude') if payload.get('latitude') is not None else payload.get('lat'))
        lng = float(payload.get('longitude') if payload.get('longitude') is not None else payload.get('lng'))
    except (TypeError, ValueError):
        return None, "Invalid latitude or longitude."

    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        return None, "Coordinates out of bounds (-90 <= lat <= 90, -180 <= lng <= 180)."

    accuracy = float(payload.get('accuracy', 0.0))
    speed = float(payload.get('speed', 0.0)) if payload.get('speed') is not None else 0.0
    heading = float(payload.get('heading', 0.0)) if payload.get('heading') is not None else 0.0

    raw_ts = payload.get('timestamp')
    if raw_ts:
        timestamp = str(raw_ts).strip()
    else:
        timestamp = datetime.utcnow().isoformat() + 'Z'

    point = (lat, lng)
    now = datetime.utcnow().isoformat() + 'Z'

    # 1. Evaluate point against active geofences & calculate distance to boundary
    fences = [f for f in (active_fences or []) if f.get('status') == 'active']
    if not fences:
        try:
            import tempfile, os
            cache_file = os.path.join(tempfile.gettempdir(), 'vf_geofences_cache.json')
            if os.path.exists(cache_file):
                with open(cache_file, 'r', encoding='utf-8') as f:
                    cdata = json.load(f)
                    if isinstance(cdata, dict):
                        fences = [f for f in cdata.values() if f.get('status') == 'active']
                    elif isinstance(cdata, list):
                        fences = [f for f in cdata if f.get('status') == 'active']
        except Exception:
            pass

    currently_inside_fences = []
    events_triggered = []

    for fence in fences:
        fid = fence['id']
        fname = fence.get('name', 'Geofence')
        fcolor = fence.get('color', '#2563eb')
        is_inside_now = evaluate_point_against_fence(point, fence)
        was_inside = get_device_fence_state(device_id, fid)

        if is_inside_now:
            currently_inside_fences.append({'id': fid, 'name': fname, 'color': fcolor})

        # State transition evaluation
        if is_inside_now and not was_inside:
            # Transition: OUTSIDE -> INSIDE: Fire ENTER event
            set_device_fence_state(device_id, fid, True)
            event_doc = {
                'event_id': f"evt_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}",
                'device_id': device_id,
                'device_name': device.get('device_name', 'Mobile Device'),
                'geofence_id': fid,
                'geofence_name': fname,
                'event_type': 'ENTER',
                'latitude': lat,
                'longitude': lng,
                'accuracy': accuracy,
                'speed': speed,
                'heading': heading,
                'color': fcolor,
                'timestamp': timestamp,
                'created_at': now
            }
            events_triggered.append(event_doc)
            _store_event(event_doc)

        elif not is_inside_now and was_inside:
            # Transition: INSIDE -> OUTSIDE: Fire EXIT event
            set_device_fence_state(device_id, fid, False)
            event_doc = {
                'event_id': f"evt_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}",
                'device_id': device_id,
                'device_name': device.get('device_name', 'Mobile Device'),
                'geofence_id': fid,
                'geofence_name': fname,
                'event_type': 'EXIT',
                'latitude': lat,
                'longitude': lng,
                'accuracy': accuracy,
                'speed': speed,
                'heading': heading,
                'color': fcolor,
                'timestamp': timestamp,
                'created_at': now
            }
            events_triggered.append(event_doc)
            _store_event(event_doc)

    # 2. Check geofence boundary & flag outside state (100m hidden radius completely removed)
    min_dist_to_fence = 0.0
    is_outside_fence = False

    if fences:
        if currently_inside_fences:
            min_dist_to_fence = 0.0
            is_outside_fence = False
        else:
            fence_distances = [distance_to_fence(point, f) for f in fences]
            min_dist_to_fence = min(fence_distances) if fence_distances else 0.0
            is_outside_fence = True

    # 3. Always track location (even outside the fence) and mark breach flag
    loc_record = {
        'id': f"loc_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}",
        'device_id': device_id,
        'device_name': device.get('device_name', 'Mobile Device'),
        'location': {
            'type': 'Point',
            'coordinates': [lng, lat]  # GeoJSON standard: [longitude, latitude]
        },
        'latitude': lat,
        'longitude': lng,
        'accuracy': accuracy,
        'speed': speed,
        'heading': heading,
        'outside_fence': is_outside_fence,
        'flagged': is_outside_fence,
        'flag': 'OUTSIDE_FENCE' if is_outside_fence else None,
        'distance_outside': round(min_dist_to_fence, 1),
        'timestamp': timestamp,
        'created_at': now
    }

    in_memory_locations.append(loc_record)
    if len(in_memory_locations) > 1000:
        in_memory_locations.pop(0)

    db = get_tracking_db()
    if db is not None:
        try:
            doc = dict(loc_record)
            db.locations.insert_one(doc)
        except Exception as e:
            print(f">> [MongoDB Location Insert Error] {e}")

    if is_outside_fence:
        fence_display = f"🚩 Outside Geofence ({round(min_dist_to_fence)}m - Flagged)"
    elif currently_inside_fences:
        fence_display = f"🟢 Inside \"{currently_inside_fences[0]['name']}\""
    else:
        fence_display = "No Active Fences"

    update_device(device_id, {
        'last_seen': timestamp,
        'status': 'online',
        'tracking_active': True,
        'is_offline_forced': False,
        'is_tab_active': True,
        'offline_reason': None,
        'outside_fence': is_outside_fence,
        'flagged': is_outside_fence,
        'distance_outside': round(min_dist_to_fence, 1),
        'last_location': {
            'latitude': lat,
            'longitude': lng,
            'accuracy': accuracy,
            'speed': speed,
            'heading': heading,
            'outside_fence': is_outside_fence,
            'flagged': is_outside_fence,
            'timestamp': timestamp
        },
        'current_fence': fence_display
    })

    return {
        'success': True,
        'device_id': device_id,
        'status': 'online',
        'tracking_active': True,
        'footprint_recorded': True,
        'outside_fence': is_outside_fence,
        'flagged': is_outside_fence,
        'coordinate': {'latitude': lat, 'longitude': lng},
        'accuracy': accuracy,
        'speed': speed,
        'distance_outside': round(min_dist_to_fence, 1),
        'inside_geofences': currently_inside_fences,
        'events': events_triggered,
        'timestamp': timestamp
    }, None

def _store_event(event_doc: dict):
    """Stores geofence ENTER / EXIT event in tracking_data_db.geofence_events."""
    in_memory_geofence_events.append(event_doc)
    if len(in_memory_geofence_events) > 300:
        in_memory_geofence_events.pop(0)

    db = get_tracking_db()
    if db is not None:
        try:
            doc = dict(event_doc)
            doc.pop('_id', None)
            db.geofence_events.insert_one(doc)
        except Exception as e:
            print(f">> [MongoDB Event Insert Error] {e}")

def list_geofence_events(limit: int = 50, device_id: str = None) -> list:
    """Lists recent geofence ENTER / EXIT events."""
    limit = max(1, min(int(limit), 200))
    db = get_tracking_db()
    if db is not None:
        try:
            query = {}
            if device_id:
                query['device_id'] = device_id
            docs = list(db.geofence_events.find(query, {'_id': 0}).sort('timestamp', -1).limit(limit))
            return docs
        except Exception as e:
            print(f">> [MongoDB List Events Error] {e}")

    results = []
    for ev in reversed(in_memory_geofence_events):
        if device_id and ev.get('device_id') != device_id:
            continue
        results.append(ev)
        if len(results) >= limit:
            break
    return results
