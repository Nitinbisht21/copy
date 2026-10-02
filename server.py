"""
Geofence Map Builder & Real GPS Multi-Device Tracking Backend
Powered by MongoDB Atlas & MongoDB Compass

Features:
  - Real-time Multi-Device GPS Telemetry Ingestion:
      - Ingestion pipeline for mobile phones and external GPS devices
      - Evaluates real geofences (Circle, Rectangle, Polygon) using spherical mathematics
      - Persistent ENTER/EXIT boundary breach detection
  - Exclusively uses MongoDB (No SQLite or local file dumps):
      1. 'simulation_data_db': Stores geofence perimeters and live footprints.
      2. 'tracking_data_db': Stores users, devices, locations (GeoJSON 2dsphere), and geofence_events.
  - REST API:
      - /api/geofences (GET, POST, DELETE)
      - /api/geofences/<id> (PUT, DELETE)
      - /api/geofences/<id>/toggle (POST)
      - /api/geofences/export (GET GeoJSON)
      - /api/auth/register, /api/auth/login
      - /api/devices, /api/devices/register, /api/devices/<id>/history
      - /api/telemetry (POST real mobile GPS coordinates)
      - /api/events (GET real boundary transition events)
      - /api/database/status (GET live MongoDB status)
  - Dual Web Server: Flask if available; built-in http.server fallback
"""

import os
import sys
import json
import math
import random
import uuid
import threading
import time
from datetime import datetime, timedelta

# -----------------------------------------------------------------------------
# ENVIRONMENT CONFIGURATION (.env)
# -----------------------------------------------------------------------------
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(env_path):
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k and k not in os.environ:
                        os.environ[k] = v
    except Exception:
        pass

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# MongoDB Driver (pymongo)
try:
    import pymongo
except ImportError:
    pymongo = None

try:
    import certifi
    ca_file = certifi.where()
except Exception:
    ca_file = None

# Real GPS Multi-Device Tracking Services
try:
    from services.db import init_tracking_db
    from services.auth_service import (
        register_user, login_user, seed_default_admin,
        get_current_user
    )
    from services.device_service import (
        register_device, list_devices, get_device, update_device,
        revoke_device, delete_device, get_device_history, purge_all_duplicates
    )
    from services.telemetry_service import (
        process_telemetry, list_geofence_events, distance_to_fence
    )
except ImportError as e:
    print(f">> [Services Import Warning] {e}")

PORT = int(os.environ.get('PORT', 5000))
MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017')
MONGODB_SIMULATION_DB = os.environ.get('MONGODB_SIMULATION_DB', 'simulation_data_db')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
EARTH_RADIUS_METERS = 6371008.8

import socket

def get_local_ip():
    """Detects primary local LAN IPv4 address for multi-device Wi-Fi tracking."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

# MongoDB Global State (Sole Database)
mongo_client = None
mongo_simulation_db = None  # geofences, real-time events & footprints
use_mongodb = False
mongo_connection_error = None

# Fast Local Cache (Synchronized with MongoDB)
in_memory_geofences = {}
in_memory_simulation_footprints = []
device_last_known_geofences = {}

# -----------------------------------------------------------------------------
# MONGODB CONNECTION & CACHE SYNCHRONIZATION
# -----------------------------------------------------------------------------

def sync_geofences_from_mongodb():
    """Synchronizes stored geofences directly from MongoDB into local memory cache."""
    global mongo_simulation_db
    if mongo_simulation_db is None:
        return

    for doc in mongo_simulation_db.geofences.find({}, {'_id': 0}):
        in_memory_geofences[doc['id']] = doc
    print(f">> [MongoDB] Synchronized {len(in_memory_geofences)} active geofences from '{MONGODB_SIMULATION_DB}.geofences'")

def init_mongo_connection(silent=False):
    """Initializes connection to MongoDB Atlas / Compass. MongoDB is the sole database."""
    global mongo_client, mongo_simulation_db, use_mongodb, mongo_connection_error

    if pymongo is None:
        mongo_connection_error = "Python package 'pymongo' is not installed. Please run: pip install pymongo dnspython"
        if not silent:
            print(f">> [MongoDB Error] {mongo_connection_error}")
        return False

    if use_mongodb and mongo_client is not None:
        try:
            mongo_client.admin.command('ping')
            return True
        except Exception:
            use_mongodb = False

    is_vercel = bool(os.environ.get('VERCEL'))
    if is_vercel:
        candidates = [MONGODB_URI]
    else:
        candidates = [MONGODB_URI]
        if '://Nitin:' in MONGODB_URI:
            candidates.append(MONGODB_URI.replace('://Nitin:', '://nitin:'))
        elif '://nitin:' in MONGODB_URI:
            candidates.append(MONGODB_URI.replace('://nitin:', '://Nitin:'))

        if 'localhost' in MONGODB_URI:
            candidates.append(MONGODB_URI.replace('localhost', '127.0.0.1'))

    last_error = None
    timeout_ms = 2500 if is_vercel else (12000 if 'mongodb+srv' in MONGODB_URI else 3000)
    for uri in candidates:
        try:
            mongo_kwargs = {
                'serverSelectionTimeoutMS': timeout_ms,
                'connectTimeoutMS': timeout_ms,
                'socketTimeoutMS': timeout_ms
            }
            if ca_file and ('mongodb+srv' in uri or 'tls=true' in uri or 'ssl=true' in uri):
                mongo_kwargs['tlsCAFile'] = ca_file

            client = pymongo.MongoClient(uri, **mongo_kwargs)
            client.admin.command('ping')
            mongo_client = client
            mongo_simulation_db = client[MONGODB_SIMULATION_DB]
            use_mongodb = True
            mongo_connection_error = None

            # Setup indexes on MongoDB collections
            mongo_simulation_db.geofences.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index([('created_at', pymongo.DESCENDING)])

            print(">> [MongoDB] ==================================================")
            print(">> [MongoDB] Live MongoDB Connection Active!")
            print(f">> [MongoDB] Geofence & Telemetry DB: '{MONGODB_SIMULATION_DB}'")
            print(f">> [MongoDB]    Collections: 'geofences', 'simulation_footprints'")
            print(f">> [MongoDB] Connected URI: {uri}")
            print(">> [MongoDB] ==================================================")

            # Sync stored geofences into cache
            sync_geofences_from_mongodb()
            try:
                init_tracking_db(mongo_client)
                seed_default_admin()
            except Exception as e:
                print(f">> [Tracking DB Init Note] {e}")
            return True
        except Exception as e:
            last_error = e
            continue

    use_mongodb = False
    mongo_connection_error = str(last_error)
    if not silent:
        print(f">> [MongoDB Notice] Could not reach MongoDB Atlas: {last_error}")
        print(f">> [MongoDB Notice] Ensure MongoDB Compass or mongod is running at: {MONGODB_URI}")
    return False

heartbeat_started = False

def start_mongo_heartbeat():
    """Background reconnect daemon to maintain persistent connection to MongoDB."""
    global heartbeat_started
    if heartbeat_started or os.environ.get('VERCEL'):
        return
    heartbeat_started = True

    def heartbeat_loop():
        while True:
            time.sleep(8)
            if not use_mongodb:
                connected = init_mongo_connection(silent=True)
                if connected:
                    print(f">> [MongoDB] Connection to MongoDB established successfully!")
    t = threading.Thread(target=heartbeat_loop, daemon=True)
    t.start()

def init_db():
    """Sole database initializer: Connects exclusively to MongoDB."""
    if not use_mongodb or mongo_client is None:
        init_mongo_connection()
    try:
        init_tracking_db(mongo_client)
        seed_default_admin()
    except Exception as e:
        pass
    if not os.environ.get('VERCEL'):
        start_mongo_heartbeat()

# -----------------------------------------------------------------------------
# SPATIAL MATHEMATICS ENGINE
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
        return is_point_in_circle(point, center, fence.get('radius', 0))
    elif ftype == 'rectangle':
        return is_point_in_rectangle(point, coords)
    elif ftype == 'polygon':
        return is_point_in_polygon(point, coords)
    return False

# -----------------------------------------------------------------------------
# MONGODB CRUD OPERATIONS (FETCHED FROM & SENT TO MONGODB)
# -----------------------------------------------------------------------------

import tempfile
CACHE_GEOFENCES_FILE = os.path.join(tempfile.gettempdir(), 'vf_geofences_cache.json')

def load_cached_geofences():
    global in_memory_geofences
    if os.path.exists(CACHE_GEOFENCES_FILE):
        try:
            with open(CACHE_GEOFENCES_FILE, 'r', encoding='utf-8') as f:
                cached = json.load(f)
                if isinstance(cached, dict):
                    in_memory_geofences.update(cached)
        except Exception:
            pass

def save_cached_geofences():
    try:
        with open(CACHE_GEOFENCES_FILE, 'w', encoding='utf-8') as f:
            json.dump(in_memory_geofences, f)
    except Exception:
        pass

def db_list_geofences():
    """Lists all geofences directly from MongoDB simulation_data_db.geofences."""
    if use_mongodb and mongo_simulation_db is not None:
        try:
            docs = list(mongo_simulation_db.geofences.find({}, {'_id': 0}).sort('created_at', -1))
            for d in docs:
                in_memory_geofences[d['id']] = d
            save_cached_geofences()
            return docs
        except Exception as e:
            print(f">> [MongoDB Read Error] {e}")
    if not in_memory_geofences:
        load_cached_geofences()
    return list(in_memory_geofences.values())

def db_create_geofence(data):
    """Creates a new geofence directly in MongoDB simulation_data_db.geofences."""
    now = datetime.utcnow().isoformat() + 'Z'
    fence_id = data.get('id') or f"geo_{int(datetime.utcnow().timestamp()*1000)}"
    name = (data.get('name') or 'Unnamed Geofence').strip()
    ftype = data.get('type')
    coords = data.get('coordinates')
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            pass
    radius = float(data.get('radius')) if ftype == 'circle' and data.get('radius') is not None else None
    status = data.get('status') or 'active'
    color = data.get('color') or '#2563eb'
    description = (data.get('description') or '').strip()

    fence_dict = {
        'id': fence_id,
        'name': name,
        'type': ftype,
        'coordinates': coords,
        'radius': radius,
        'status': status,
        'color': color,
        'description': description,
        'created_at': now,
        'updated_at': now
    }

    in_memory_geofences[fence_id] = fence_dict
    save_cached_geofences()

    if use_mongodb and mongo_simulation_db is not None:
        try:
            doc = dict(fence_dict)
            doc.pop('_id', None)
            mongo_simulation_db.geofences.replace_one({'id': fence_id}, doc, upsert=True)
        except Exception as e:
            print(f">> [MongoDB Write Error] {e}")

    return fence_dict

def db_update_geofence(fence_id, data):
    """Updates an existing geofence directly in MongoDB simulation_data_db.geofences."""
    existing = in_memory_geofences.get(fence_id)

    if use_mongodb and mongo_simulation_db is not None:
        try:
            mongo_doc = mongo_simulation_db.geofences.find_one({'id': fence_id}, {'_id': 0})
            if mongo_doc:
                existing = mongo_doc
        except Exception:
            pass

    if not existing:
        return None

    now = datetime.utcnow().isoformat() + 'Z'
    updated = dict(existing)
    for k in ['name', 'type', 'coordinates', 'radius', 'status', 'color', 'description']:
        if k in data:
            val = data[k]
            if k == 'coordinates' and isinstance(val, str):
                try:
                    val = json.loads(val)
                except Exception:
                    pass
            updated[k] = val
    updated['updated_at'] = now
    in_memory_geofences[fence_id] = updated

    if use_mongodb and mongo_simulation_db is not None:
        try:
            doc = dict(updated)
            doc.pop('_id', None)
            mongo_simulation_db.geofences.replace_one({'id': fence_id}, doc)
        except Exception as e:
            print(f">> [MongoDB Update Error] {e}")

    return updated

def db_delete_geofence(fence_id):
    """Deletes a geofence directly from MongoDB simulation_data_db.geofences."""
    deleted = fence_id in in_memory_geofences
    in_memory_geofences.pop(fence_id, None)

    if use_mongodb and mongo_simulation_db is not None:
        try:
            res = mongo_simulation_db.geofences.delete_one({'id': fence_id})
            deleted = deleted or (res.deleted_count > 0)
        except Exception as e:
            print(f">> [MongoDB Delete Error] {e}")

    return deleted

def db_toggle_geofence(fence_id):
    """Toggles status ('active' <-> 'disabled') directly in MongoDB."""
    existing = in_memory_geofences.get(fence_id)
    if use_mongodb and mongo_simulation_db is not None:
        try:
            mongo_doc = mongo_simulation_db.geofences.find_one({'id': fence_id}, {'_id': 0})
            if mongo_doc:
                existing = mongo_doc
        except Exception:
            pass

    if not existing:
        return None

    new_status = 'disabled' if existing.get('status') == 'active' else 'active'
    return db_update_geofence(fence_id, {'status': new_status})

def db_clear_all():
    """Clears all geofences directly from MongoDB simulation_data_db.geofences."""
    in_memory_geofences.clear()
    if use_mongodb and mongo_simulation_db is not None:
        try:
            mongo_simulation_db.geofences.delete_many({})
        except Exception as e:
            print(f">> [MongoDB Clear Error] {e}")


def db_export_geojson():
    """Exports all stored geofences as GeoJSON FeatureCollection."""
    fences = db_list_geofences()
    features = []
    for f in fences:
        geom = None
        c = f.get('coordinates')
        if isinstance(c, str):
            try:
                c = json.loads(c)
            except Exception:
                continue

        if f['type'] == 'circle' and isinstance(c, dict):
            geom = {'type': 'Point', 'coordinates': [c.get('lng', 0), c.get('lat', 0)]}
        elif f['type'] == 'rectangle' and isinstance(c, dict):
            geom = {
                'type': 'Polygon',
                'coordinates': [[[c['west'], c['north']], [c['east'], c['north']],
                                 [c['east'], c['south']], [c['west'], c['south']],
                                 [c['west'], c['north']]]]
            }
        elif f['type'] == 'polygon' and isinstance(c, list):
            ring = [[pt[1], pt[0]] for pt in c]
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
            geom = {'type': 'Polygon', 'coordinates': [ring]}

        features.append({
            'type': 'Feature',
            'id': f['id'],
            'properties': f,
            'geometry': geom
        })
    return {'type': 'FeatureCollection', 'features': features}

def evaluate_telemetry(data):
    """Evaluates GPS coordinates in real-time against active MongoDB geofences."""
    device_id = str(data.get('device_id', 'MOUSE_POINTER'))
    lat = float(data.get('latitude') or data.get('lat', 0.0))
    lng = float(data.get('longitude') or data.get('lng', 0.0))
    point = (lat, lng)

    all_fences = db_list_geofences()
    currently_inside = set()
    inside_details = []

    for f in all_fences:
        if f.get('status') == 'active' and evaluate_point_against_fence(point, f):
            currently_inside.add(f['id'])
            inside_details.append({
                'id': f['id'],
                'name': f['name'],
                'type': f['type'],
                'color': f.get('color', '#2563eb')
            })

    previously_inside = device_last_known_geofences.get(device_id, set())
    device_last_known_geofences[device_id] = currently_inside

    events = []
    for fid in (currently_inside - previously_inside):
        matched_fence = next((f for f in all_fences if f['id'] == fid), None)
        fname = matched_fence['name'] if matched_fence else 'Geofence'
        fcolor = matched_fence.get('color', '#2563eb') if matched_fence else '#2563eb'
        ev = {
            'event': 'ENTER',
            'device_id': device_id,
            'geofence_id': fid,
            'geofence_name': fname,
            'color': fcolor,
            'latitude': lat,
            'longitude': lng,
            'source': 'telemetry_stream',
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }
        events.append(ev)
        # Record boundary transition to MongoDB simulation database
        db_record_footprint(ev)

    for fid in (previously_inside - currently_inside):
        matched_fence = next((f for f in all_fences if f['id'] == fid), None)
        fname = matched_fence['name'] if matched_fence else 'Geofence'
        fcolor = matched_fence.get('color', '#2563eb') if matched_fence else '#2563eb'
        ev = {
            'event': 'EXIT',
            'device_id': device_id,
            'geofence_id': fid,
            'geofence_name': fname,
            'color': fcolor,
            'latitude': lat,
            'longitude': lng,
            'source': 'telemetry_stream',
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }
        events.append(ev)
        # Record boundary transition to MongoDB simulation database
        db_record_footprint(ev)

    # Calculate distance to active fences
    min_dist_to_fence = 0.0
    is_outside_100m = False
    active_fences = [f for f in all_fences if f.get('status') == 'active']

    if active_fences:
        if currently_inside:
            min_dist_to_fence = 0.0
            is_outside_100m = False
        else:
            try:
                distances = [distance_to_fence(point, f) for f in active_fences]
                min_dist_to_fence = min(distances) if distances else 0.0
                if min_dist_to_fence > 100.0:
                    is_outside_100m = True
            except Exception:
                pass

    return {
        'device_id': device_id,
        'coordinate': {'latitude': lat, 'longitude': lng},
        'status': 'offline' if is_outside_100m else 'online',
        'tracking_active': not is_outside_100m,
        'distance_outside': round(min_dist_to_fence, 1),
        'inside_geofences': [] if is_outside_100m else inside_details,
        'events': events
    }

# -----------------------------------------------------------------------------
# FOOTPRINT RECORDING & MONGODB DISPATCHER
# -----------------------------------------------------------------------------

def db_record_footprint(data):
    """
    Stores footprint and geofence boundary events directly in MongoDB:
    Persistent collection: simulation_data_db.simulation_footprints
    """
    fid = data.get('id') or f"fp_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}"
    now = datetime.utcnow().isoformat() + 'Z'
    device_id = str(data.get('device_id', 'GPS_DEVICE'))
    geofence_id = data.get('geofence_id')
    geofence_name = data.get('geofence_name')
    latitude = float(data.get('latitude', 0.0))
    longitude = float(data.get('longitude', 0.0))
    event = str(data.get('event', 'INSIDE')).upper()
    source = str(data.get('source', 'gps_telemetry'))

    color = data.get('color')
    if not color and geofence_id:
        fence = in_memory_geofences.get(geofence_id)
        if fence and fence.get('color'):
            color = fence['color']

    record = {
        'id': fid,
        'device_id': device_id,
        'geofence_id': geofence_id,
        'geofence_name': geofence_name,
        'latitude': latitude,
        'longitude': longitude,
        'event': event,
        'color': color or '#2563eb',
        'source': source,
        'database': MONGODB_SIMULATION_DB,
        'collection': 'simulation_footprints',
        'created_at': now
    }

    # Store in memory cache
    in_memory_simulation_footprints.insert(0, record)
    if len(in_memory_simulation_footprints) > 300:
        in_memory_simulation_footprints.pop()

    # Store in MongoDB (Atlas & Compass)
    if use_mongodb and mongo_simulation_db is not None:
        try:
            doc = dict(record)
            doc.pop('_id', None)
            mongo_simulation_db.simulation_footprints.insert_one(doc)
        except Exception as e:
            print(f">> [MongoDB Footprint Write Error] {e}")

    return record

def db_list_footprints(limit=50, target='all'):
    """Lists footprints directly from MongoDB."""
    limit = int(limit)

    if use_mongodb and mongo_simulation_db is not None:
        try:
            docs = list(mongo_simulation_db.simulation_footprints.find({}, {'_id': 0}).sort('created_at', -1).limit(limit))
            for d in docs:
                d['database'] = MONGODB_SIMULATION_DB
                d['collection'] = 'simulation_footprints'
            return docs
        except Exception as e:
            print(f">> [MongoDB List Footprints Error] {e}")

    return in_memory_simulation_footprints[:limit]

def db_clear_footprints():
    """Clears footprints directly from MongoDB collection."""
    in_memory_simulation_footprints.clear()

    if use_mongodb and mongo_simulation_db is not None:
        try:
            mongo_simulation_db.simulation_footprints.delete_many({})
        except Exception as e:
            print(f">> [MongoDB Clear Footprints Error] {e}")

    return True

def mask_mongodb_uri(uri: str) -> str:
    """Masks password credentials in MongoDB URI for safe public reporting."""
    if not uri or '@' not in uri or '://' not in uri:
        return 'mongodb://localhost:27017'
    try:
        prefix, rest = uri.split('://', 1)
        creds, host_part = rest.split('@', 1)
        if ':' in creds:
            user = creds.split(':', 1)[0]
            return f"{prefix}://{user}:********@{host_part}"
        return f"{prefix}://********@{host_part}"
    except Exception:
        return 'mongodb+srv://********@cluster.mongodb.net/'

# -----------------------------------------------------------------------------
# SOURCE CODE & ASSET SECURITY: STRICT ACCESS FILTER
# Strictly prevents public exposure of .env, .git, *.py, services/, models/,
# internal logs, scripts, and sensitive directories.
# -----------------------------------------------------------------------------
ALLOWED_STATIC_PREFIXES = ('css/', 'js/', 'vendor/')
ALLOWED_ROOT_FILES = {'index.html', 'track.html', 'favicon.ico', 'robots.txt'}
BLOCKED_EXTENSIONS = (
    '.py', '.pyc', '.pyd', '.pyo', '.env', '.db', '.sqlite', '.sqlite3',
    '.log', '.bat', '.cmd', '.ps1', '.sh', '.md', '.txt', '.json',
    '.yml', '.yaml', '.git', '.lock', '.example', '.ini', '.cfg'
)

def is_safe_static_request(req_path: str) -> bool:
    """Verifies that requested path is explicitly in the public asset allowlist."""
    if not req_path:
        return False

    clean_path = req_path.replace('\\', '/').strip('/')

    # Block directory traversal
    if '..' in clean_path or clean_path.startswith('/'):
        return False

    # Block hidden files or directories (.env, .git, etc.)
    for segment in clean_path.split('/'):
        if segment.startswith('.'):
            return False

    # Block all sensitive extensions
    lower_path = clean_path.lower()
    for ext in BLOCKED_EXTENSIONS:
        if lower_path.endswith(ext):
            return False

    # Allow exact root files
    if clean_path in ALLOWED_ROOT_FILES:
        return True

    # Allow approved asset subdirectories (css/, js/, vendor/)
    for prefix in ALLOWED_STATIC_PREFIXES:
        if clean_path.startswith(prefix):
            return True

    return False

def get_database_status():
    """Returns database status. Exclusively reports live MongoDB state and multi-device telemetry."""
    sim_fences = 0
    sim_footprints = 0
    dev_count = 0
    loc_count = 0
    evt_count = 0

    if use_mongodb and mongo_client is not None:
        try:
            if mongo_simulation_db is not None:
                sim_fences = mongo_simulation_db.geofences.count_documents({})
                sim_footprints = mongo_simulation_db.simulation_footprints.count_documents({})
            tdb = mongo_client.get_database('tracking_data_db')
            if tdb is not None:
                dev_count = tdb.devices.count_documents({})
                loc_count = tdb.locations.count_documents({})
                evt_count = tdb.geofence_events.count_documents({})
        except Exception:
            sim_fences = len(in_memory_geofences)
            sim_footprints = len(in_memory_simulation_footprints)
    else:
        sim_fences = len(in_memory_geofences)
        sim_footprints = len(in_memory_simulation_footprints)

    return {
        'active_database': 'MongoDB Atlas & Compass',
        'active_engine': 'MongoDB',
        'mongodb_connected': use_mongodb,
        'mongodb_uri': mask_mongodb_uri(MONGODB_URI),
        'compass_connection_string': mask_mongodb_uri(MONGODB_URI),
        'mongodb_database': MONGODB_SIMULATION_DB,
        'geofences_database': MONGODB_SIMULATION_DB,
        'tracking_database': 'tracking_data_db',
        'connection_error': mongo_connection_error,
        'geofences_count': sim_fences,
        'footprints_count': sim_footprints,
        'registered_devices_count': dev_count,
        'gps_locations_count': loc_count,
        'geofence_events_count': evt_count,
        'local_ip': get_local_ip(),
        'phone_track_url': f"http://{get_local_ip()}:{PORT}/track"
    }

# -----------------------------------------------------------------------------
# ENGINE 1: FLASK WEB ENGINE
# -----------------------------------------------------------------------------

def create_app():
    from flask import Flask, request, jsonify, send_from_directory
    init_db()
    app = Flask(__name__, static_folder=None)

    @app.before_request
    def protect_source_code():
        if request.method == 'OPTIONS':
            resp = app.make_response(('', 200))
            resp.headers['Access-Control-Allow-Origin'] = '*'
            resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
            resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
            return resp

        path = request.path.lstrip('/')
        # Exempt all API routes, internal functions, and core app pages
        if (not path or
            path.startswith('api') or
            path in ('track', 'track.html', 'user', 'admin', 'index.html', 'index.py', 'api/index.py') or
            path.startswith(('geofences', 'footprints', 'telemetry', 'devices', 'events', 'auth', 'database', 'network'))):
            return None

        if not is_safe_static_request(path):
            return jsonify({'error': 'Access denied: Source code and internal configuration files are protected.'}), 403

    @app.after_request
    def cors(resp):
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        return resp

    @app.route('/api/geofences', methods=['GET'])
    @app.route('/geofences', methods=['GET'])
    def api_get():
        return jsonify(db_list_geofences())

    @app.route('/api/geofences', methods=['POST'])
    @app.route('/geofences', methods=['POST'])
    def api_post():
        data = request.get_json(force=True)
        return jsonify(db_create_geofence(data)), 201


    @app.route('/api/geofences/<fid>', methods=['PUT'])
    @app.route('/geofences/<fid>', methods=['PUT'])
    def api_put(fid):
        data = request.get_json(force=True)
        res = db_update_geofence(fid, data)
        return jsonify(res) if res else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences/<fid>', methods=['DELETE'])
    @app.route('/geofences/<fid>', methods=['DELETE'])
    def api_del(fid):
        return jsonify({'success': True}) if db_delete_geofence(fid) else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences/<fid>/toggle', methods=['POST'])
    @app.route('/geofences/<fid>/toggle', methods=['POST'])
    def api_tog(fid):
        res = db_toggle_geofence(fid)
        return jsonify(res) if res else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences', methods=['DELETE'])
    @app.route('/geofences', methods=['DELETE'])
    def api_clear():
        db_clear_all()
        return jsonify({'success': True})

    @app.route('/api/geofences/export', methods=['GET'])
    @app.route('/geofences/export', methods=['GET'])
    def api_export():
        return jsonify(db_export_geojson())

    def check_admin_access(req):
        user = get_current_user(req)
        if user and user.get('role') != 'admin':
            return False, "Access denied. Administrator privileges required."
        return True, None

    # --- Authentication Endpoints ---
    @app.route('/api/auth/register', methods=['POST'])
    @app.route('/auth/register', methods=['POST'])
    def api_auth_register():
        data = request.get_json(force=True) or {}
        user, err = register_user(
            name=data.get('name', ''),
            email=data.get('email', ''),
            password=data.get('password', ''),
            role=data.get('role', 'user')
        )
        if err:
            return jsonify({'error': err}), 400
        login_res, _ = login_user(data.get('email'), data.get('password'))
        if login_res:
            safe_user, token = login_res
            return jsonify({'user': safe_user, 'token': token}), 201
        return jsonify({'user': user}), 201

    @app.route('/api/auth/login', methods=['POST'])
    @app.route('/auth/login', methods=['POST'])
    def api_auth_login():
        data = request.get_json(force=True) or {}
        res, err = login_user(data.get('email', ''), data.get('password', ''))
        if err:
            return jsonify({'error': err}), 401
        safe_user, token = res
        return jsonify({'user': safe_user, 'token': token})

    @app.route('/api/auth/me', methods=['GET'])
    @app.route('/auth/me', methods=['GET'])
    def api_auth_me():
        user = get_current_user(request)
        if not user:
            return jsonify({'error': 'Unauthorized'}), 401
        return jsonify({'user': user})

    # --- Device Management Endpoints ---
    @app.route('/api/devices/register', methods=['POST'])
    @app.route('/devices/register', methods=['POST'])
    def api_register_device():
        data = request.get_json(force=True) or {}
        user = get_current_user(request)
        user_id = (user and user.get('user_id')) or data.get('user_id') or 'anon_user'
        client_ip = request.headers.get('x-forwarded-for', request.remote_addr)
        if client_ip and ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        device, err = register_device(
            device_name=data.get('device_name'),
            user_id=user_id,
            platform=data.get('platform', 'browser'),
            custom_id=data.get('device_id'),
            fingerprint=data.get('fingerprint'),
            client_ip=client_ip
        )
        if err:
            return jsonify({'error': err}), 400
        return jsonify(device), 201

    @app.route('/api/devices/purge-duplicates', methods=['POST'])
    @app.route('/devices/purge-duplicates', methods=['POST'])
    def api_purge_device_duplicates():
        allowed, err = check_admin_access(request)
        if not allowed:
            return jsonify({'error': err}), 403
        remaining_count = purge_all_duplicates()
        return jsonify({'success': True, 'remaining_devices': remaining_count})

    @app.route('/api/devices', methods=['GET'])
    @app.route('/devices', methods=['GET'])
    def api_get_devices():
        user = get_current_user(request)
        filter_uid = None
        if user and user.get('role') == 'user':
            filter_uid = user.get('user_id')
        elif request.args.get('user_id'):
            filter_uid = request.args.get('user_id')
        return jsonify(list_devices(user_id=filter_uid, include_revoked=False))

    @app.route('/api/devices/<did>', methods=['GET'])
    @app.route('/devices/<did>', methods=['GET'])
    def api_get_device(did):
        device = get_device(did)
        if not device:
            return jsonify({'error': 'Device not found'}), 404
        return jsonify(device)

    @app.route('/api/devices/<did>', methods=['PUT'])
    @app.route('/devices/<did>', methods=['PUT'])
    def api_update_device(did):
        data = request.get_json(force=True) or {}
        updated = update_device(did, data)
        if not updated:
            return jsonify({'error': 'Device not found'}), 404
        return jsonify(updated)

    @app.route('/api/devices/<did>', methods=['DELETE'])
    @app.route('/devices/<did>', methods=['DELETE'])
    def api_delete_device(did):
        allowed, err = check_admin_access(request)
        if not allowed:
            return jsonify({'error': err}), 403
        delete_device(did)
        return jsonify({'success': True})

    @app.route('/api/devices/<did>/revoke', methods=['POST'])
    @app.route('/devices/<did>/revoke', methods=['POST'])
    def api_revoke_device(did):
        allowed, err = check_admin_access(request)
        if not allowed:
            return jsonify({'error': err}), 403
        revoked = revoke_device(did)
        if not revoked:
            return jsonify({'error': 'Device not found'}), 404
        return jsonify({'success': True, 'device_id': did, 'status': 'revoked'})

    @app.route('/api/devices/<did>/history', methods=['GET'])
    @app.route('/devices/<did>/history', methods=['GET'])
    def api_get_device_history(did):
        limit = request.args.get('limit', 150)
        from_time = request.args.get('from')
        to_time = request.args.get('to')
        return jsonify(get_device_history(did, limit=limit, from_time=from_time, to_time=to_time))

    # --- Real Telemetry Endpoint ---
    @app.route('/api/telemetry', methods=['POST'])
    @app.route('/telemetry', methods=['POST'])
    def api_real_telemetry():
        data = request.get_json(force=True) or {}
        client_ip = request.headers.get('x-forwarded-for', request.remote_addr)
        if client_ip and ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        if 'client_ip' not in data:
            data['client_ip'] = client_ip
        active_fences = db_list_geofences()
        result, err = process_telemetry(data, active_fences)
        if err:
            return jsonify({'error': err}), 400

        # When inside fence or within 100m: record periodic footprint to simulation_footprints
        # When outside fence (>100m): footprint_recorded is False, so NO footprint is shared to db
        if result and result.get('footprint_recorded', True):
            coord = result.get('coordinate') or {}
            primary_fence = (result.get('inside_geofences') and result['inside_geofences'][0]) or {}
            db_record_footprint({
                'device_id': result.get('device_id'),
                'geofence_id': primary_fence.get('id'),
                'geofence_name': primary_fence.get('name', 'Safe Zone / Buffer'),
                'latitude': coord.get('latitude', 0.0),
                'longitude': coord.get('longitude', 0.0),
                'event': 'FOOTPRINT_UPDATE',
                'color': primary_fence.get('color', '#10b981'),
                'source': 'real_mobile_gps'
            })
            if result.get('events'):
                for ev in result['events']:
                    db_record_footprint({
                        'device_id': ev['device_id'],
                        'geofence_id': ev['geofence_id'],
                        'geofence_name': ev['geofence_name'],
                        'latitude': ev['latitude'],
                        'longitude': ev['longitude'],
                        'event': ev['event_type'],
                        'color': ev.get('color', '#2563eb'),
                        'source': 'real_mobile_gps'
                    })
        return jsonify(result), 200

    # --- Geofence Events History Endpoint ---
    @app.route('/api/events', methods=['GET'])
    @app.route('/events', methods=['GET'])
    def api_get_events():
        limit = request.args.get('limit', 50)
        did = request.args.get('device_id')
        return jsonify(list_geofence_events(limit=int(limit), device_id=did))

    @app.route('/api/telemetry/evaluate', methods=['POST'])
    @app.route('/telemetry/evaluate', methods=['POST'])
    def api_telemetry():
        data = request.get_json(force=True)
        return jsonify(evaluate_telemetry(data))

    @app.route('/api/footprints', methods=['GET'])
    @app.route('/footprints', methods=['GET'])
    def api_get_footprints():
        limit = request.args.get('limit', 50)
        target = request.args.get('target', 'all')
        return jsonify(db_list_footprints(limit, target))

    @app.route('/api/footprints', methods=['POST'])
    @app.route('/footprints', methods=['POST'])
    def api_post_footprint():
        data = request.get_json(force=True)
        return jsonify(db_record_footprint(data)), 201

    @app.route('/api/footprints', methods=['DELETE'])
    @app.route('/footprints', methods=['DELETE'])
    def api_delete_footprints():
        db_clear_footprints()
        return jsonify({'success': True})



    @app.route('/api/database/status', methods=['GET'])
    @app.route('/database/status', methods=['GET'])
    def api_db_status():
        if not use_mongodb:
            init_mongo_connection(silent=True)
        return jsonify(get_database_status())

    @app.route('/api/network/info', methods=['GET'])
    @app.route('/network/info', methods=['GET'])
    def api_network_info():
        host = request.headers.get('x-forwarded-host') or request.host
        proto = request.headers.get('x-forwarded-proto') or ('https' if os.environ.get('VERCEL') else 'http')
        if os.environ.get('VERCEL') or (host and 'vercel.app' in host):
            return jsonify({
                'local_ip': host,
                'port': 443,
                'track_url': f"{proto}://{host}/track",
                'admin_url': f"{proto}://{host}/"
            })
        ip = get_local_ip()
        return jsonify({
            'local_ip': ip,
            'port': PORT,
            'track_url': f"http://{ip}:{PORT}/track",
            'admin_url': f"http://{ip}:{PORT}/"
        })

    @app.route('/api')
    @app.route('/api/')
    @app.route('/api/index')
    @app.route('/api/index.py')
    @app.route('/index.py')
    def api_root_info():
        return jsonify({
            'status': 'online',
            'service': 'Virtual Fence GPS Tracking API',
            'message': 'API is active and running',
            'version': '2.0',
            'admin_url': '/',
            'track_url': '/track',
            'endpoints': {
                'devices': '/api/devices',
                'telemetry': '/api/telemetry',
                'geofences': '/api/geofences',
                'events': '/api/events',
                'database_status': '/api/database/status',
                'network_info': '/api/network/info'
            }
        })

    @app.route('/track')
    @app.route('/track.html')
    @app.route('/api/track')
    @app.route('/api/track.html')
    @app.route('/user')
    def route_track():
        return send_from_directory(STATIC_DIR, 'track.html')

    @app.route('/admin')
    @app.route('/api/admin')
    def route_admin():
        return send_from_directory(STATIC_DIR, 'index.html')

    @app.route('/')
    @app.route('/index.html')
    @app.route('/api/index.html')
    def root():
        return send_from_directory(STATIC_DIR, 'index.html')

    @app.route('/<path:p>')
    def files(p):
        clean_p = p.replace('\\', '/').strip('/')
        if clean_p in ('track', 'track.html', 'user'):
            return send_from_directory(STATIC_DIR, 'track.html')
        if clean_p in ('admin', 'index.html'):
            return send_from_directory(STATIC_DIR, 'index.html')
        if not is_safe_static_request(clean_p):
            return jsonify({'error': 'Access denied: Source code and internal configuration files are protected.'}), 403
        return send_from_directory(STATIC_DIR, clean_p)

    return app

def run_flask():
    app = create_app()
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)

# -----------------------------------------------------------------------------
# ENGINE 2: BUILT-IN HTTP SERVER FALLBACK
# -----------------------------------------------------------------------------

def run_builtin():
    from http.server import HTTPServer, SimpleHTTPRequestHandler
    import urllib.parse

    class GeofenceHandler(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            if path == '/api/geofences':
                self.send_json(db_list_geofences())
            elif path == '/api/database/status':
                self.send_json(get_database_status())
            elif path == '/api/network/info':
                ip = get_local_ip()
                self.send_json({
                    'local_ip': ip,
                    'port': PORT,
                    'track_url': f"http://{ip}:{PORT}/track",
                    'admin_url': f"http://{ip}:{PORT}/"
                })
            elif path == '/api/devices':
                qs = urllib.parse.parse_qs(parsed.query)
                uid = qs.get('user_id', [None])[0]
                self.send_json(list_devices(user_id=uid))
            elif path.startswith('/api/devices/') and path.endswith('/history'):
                did = path.split('/')[3]
                qs = urllib.parse.parse_qs(parsed.query)
                lim = int(qs.get('limit', [150])[0])
                self.send_json(get_device_history(did, limit=lim))
            elif path.startswith('/api/devices/'):
                did = path.split('/')[3]
                dev = get_device(did)
                if dev:
                    self.send_json(dev)
                else:
                    self.send_json({'error': 'Not found'}, status=404)
            elif path == '/api/events':
                qs = urllib.parse.parse_qs(parsed.query)
                lim = int(qs.get('limit', [50])[0])
                did = qs.get('device_id', [None])[0]
                self.send_json(list_geofence_events(limit=lim, device_id=did))
            elif path == '/api/footprints':
                qs = urllib.parse.parse_qs(parsed.query)
                limit = int(qs.get('limit', [50])[0])
                target = qs.get('target', ['all'])[0]
                self.send_json(db_list_footprints(limit, target))
            elif path == '/api/geofences/export':
                self.send_json(db_export_geojson())
            else:
                if path in ('/', '/admin'):
                    self.path = '/index.html'
                    super().do_GET()
                elif path in ('/track', '/user'):
                    self.path = '/track.html'
                    super().do_GET()
                else:
                    clean = path.lstrip('/')
                    if is_safe_static_request(clean):
                        super().do_GET()
                    else:
                        self.send_json({'error': 'Access denied: Source code and internal configuration files are protected.'}, status=403)

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            body = self.read_json_body()

            if path == '/api/auth/register':
                u, err = register_user(body.get('name'), body.get('email'), body.get('password'), body.get('role', 'user'))
                if err:
                    self.send_json({'error': err}, status=400)
                else:
                    lr, _ = login_user(body.get('email'), body.get('password'))
                    self.send_json({'user': lr[0], 'token': lr[1]} if lr else {'user': u}, status=201)
            elif path == '/api/auth/login':
                res, err = login_user(body.get('email'), body.get('password'))
                if err:
                    self.send_json({'error': err}, status=401)
                else:
                    self.send_json({'user': res[0], 'token': res[1]})
            elif path == '/api/devices/register':
                dev, err = register_device(body.get('device_name'), body.get('user_id', 'anon'), body.get('platform', 'browser'), body.get('device_id'))
                if err:
                    self.send_json({'error': err}, status=400)
                else:
                    self.send_json(dev, status=201)
            elif path == '/api/telemetry':
                res, err = process_telemetry(body, db_list_geofences())
                if err:
                    self.send_json({'error': err}, status=400)
                else:
                    if res and res.get('footprint_recorded', True):
                        coord = res.get('coordinate') or {}
                        primary_fence = (res.get('inside_geofences') and res['inside_geofences'][0]) or {}
                        db_record_footprint({
                            'device_id': res.get('device_id'),
                            'geofence_id': primary_fence.get('id'),
                            'geofence_name': primary_fence.get('name', 'Safe Zone / Buffer'),
                            'latitude': coord.get('latitude', 0.0),
                            'longitude': coord.get('longitude', 0.0),
                            'event': 'FOOTPRINT_UPDATE',
                            'color': primary_fence.get('color', '#10b981'),
                            'source': 'real_mobile_gps'
                        })
                        if res.get('events'):
                            for ev in res['events']:
                                db_record_footprint({
                                    'device_id': ev['device_id'],
                                    'geofence_id': ev['geofence_id'],
                                    'geofence_name': ev['geofence_name'],
                                    'latitude': ev['latitude'],
                                    'longitude': ev['longitude'],
                                    'event': ev['event_type'],
                                    'color': ev.get('color', '#2563eb'),
                                    'source': 'real_mobile_gps'
                                })
                    self.send_json(res, status=200)
            elif path == '/api/geofences':
                created = db_create_geofence(body)
                self.send_json(created, status=201)

            elif path == '/api/footprints':
                created = db_record_footprint(body)
                self.send_json(created, status=201)
            elif path == '/api/telemetry/evaluate':
                self.send_json(evaluate_telemetry(body))
            elif path.startswith('/api/geofences/') and path.endswith('/toggle'):
                fid = path.split('/')[3]
                updated = db_toggle_geofence(fid)
                if updated:
                    self.send_json(updated)
                else:
                    self.send_json({'error': 'Not found'}, status=404)
            else:
                self.send_json({'error': 'Unknown endpoint'}, status=404)

        def do_PUT(self):
            path = urllib.parse.urlparse(self.path).path
            body = self.read_json_body()
            if path.startswith('/api/geofences/'):
                fid = path.split('/')[-1]
                updated = db_update_geofence(fid, body)
                if updated:
                    self.send_json(updated)
                else:
                    self.send_json({'error': 'Not found'}, status=404)

        def do_DELETE(self):
            path = urllib.parse.urlparse(self.path).path
            if path == '/api/geofences':
                db_clear_all()
                self.send_json({'success': True})
            elif path == '/api/footprints':
                db_clear_footprints()
                self.send_json({'success': True})
            elif path.startswith('/api/geofences/'):
                fid = path.split('/')[-1]
                if db_delete_geofence(fid):
                    self.send_json({'success': True})
                else:
                    self.send_json({'error': 'Not found'}, status=404)

        def read_json_body(self):
            length = int(self.headers.get('Content-Length', 0))
            if length > 0:
                raw = self.rfile.read(length).decode('utf-8')
                return json.loads(raw)
            return {}

        def send_json(self, data, status=200):
            content = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    server = HTTPServer(('0.0.0.0', PORT), GeofenceHandler)
    server.serve_forever()

# -----------------------------------------------------------------------------
# MAIN BOOTSTRAP
# -----------------------------------------------------------------------------

if __name__ == '__main__':
    init_db()
    db_stat = get_database_status()
    print("=" * 64)
    print(">> GEOFENCE MAP BUILDER - PYTHON BACKEND")
    print(f">> Exclusive Database Engine: MongoDB Atlas & Compass")
    if db_stat['mongodb_connected']:
        print(f">> MongoDB Compass URI: {db_stat['mongodb_uri']}")
        print(f">> 1. Geofences DB: '{db_stat.get('mongodb_database')}' (geofences, simulation_footprints)")
        print(f">> 2. Tracking DB:  '{db_stat.get('tracking_database')}' (devices, locations, geofence_events)")
    else:
        print(f">> MongoDB Connecting... Target URI: {MONGODB_URI}")
    local_ip = get_local_ip()
    print(f">> Serving Dashboard at: http://localhost:{PORT}")
    print(f">> Phone Tracking URL (Same Wi-Fi): http://{local_ip}:{PORT}/track")
    print("=" * 64)

    try:
        import flask
        print(">> Web Engine: Flask Active")
        run_flask()
    except ImportError:
        print(">> Web Engine: Built-in Python HTTP Engine (Flask not in this environment)")
        run_builtin()
