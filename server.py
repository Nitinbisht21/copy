"""
Geofence Map Builder - Python Backend
Exclusively Powered by MongoDB (MongoDB Atlas & MongoDB Compass)

Features:
  - Exclusively uses MongoDB (No SQLite or local file dumps)
  - All data is fetched from MongoDB and sent to MongoDB
  - Dedicated MongoDB Databases:
      1. 'simulation_data_db': Stores geofence perimeters, real-time mouse telemetry, and simulation events.
      2. 'dummy_data_db': Stores generated area dummy data including full ENTER, INSIDE, and EXIT event sequences.
  - Generates realistic dummy movement sequences:
      - ENTER: Boundary entry flag event
      - INSIDE: Core operational waypoint
      - EXIT: Boundary exit flag event
  - Real-time Mouse Telemetry Engine:
      - Records mouse cursor movement, fence crossing (ENTER/EXIT), and mouse click events to MongoDB.
  - REST API:
      - /api/geofences (GET, POST, DELETE)
      - /api/geofences/sample (POST to seed/restore sample fences in MongoDB)
      - /api/geofences/<id> (PUT, DELETE)
      - /api/geofences/<id>/toggle (POST)
      - /api/geofences/export (GET GeoJSON)
      - /api/telemetry/evaluate (POST real-time GPS evaluation)
      - /api/footprints (GET, POST, DELETE)
      - /api/simulation/generate (POST to generate & store ENTER, INSIDE, EXIT dummy data in MongoDB)
      - /api/database/status (GET live MongoDB Atlas/Compass status)
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

PORT = int(os.environ.get('PORT', 5000))
MONGODB_URI = os.environ.get(
    'MONGODB_URI',
    'mongodb+srv://Nitin:fence@cluster0.7ulskib.mongodb.net/?retryWrites=true&w=majority'
)
MONGODB_SIMULATION_DB = os.environ.get('MONGODB_SIMULATION_DB', 'simulation_data_db')
MONGODB_DUMMY_DB = os.environ.get('MONGODB_DUMMY_DB', 'dummy_data_db')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
EARTH_RADIUS_METERS = 6371008.8

# MongoDB Global State (Sole Database)
mongo_client = None
mongo_simulation_db = None  # DB 1: simulation_data_db (geofences, simulation_footprints)
mongo_dummy_db = None       # DB 2: dummy_data_db (dummy_footprints)
use_mongodb = False
mongo_connection_error = None

# Fast Local Cache (Synchronized with MongoDB)
in_memory_geofences = {}
in_memory_simulation_footprints = []
in_memory_dummy_footprints = []
device_last_known_geofences = {}

# -----------------------------------------------------------------------------
# SAMPLE DATA DEFINITIONS (STORED EXCLUSIVELY IN MONGODB)
# -----------------------------------------------------------------------------
SAMPLE_GEOFENCES = [
    {
        'id': 'geo_demo_alpha',
        'name': 'Demo Alpha Perimeter',
        'type': 'circle',
        'coordinates': {'lat': 30.123456, 'lng': 78.123456},
        'radius': 320.0,
        'status': 'active',
        'color': '#2563eb',
        'description': 'Auto-generated demo circular perimeter with real-time telemetry',
        'created_at': '2026-09-28T12:00:00.000Z',
        'updated_at': '2026-09-28T12:00:00.000Z'
    },
    {
        'id': 'geo_demo_depot',
        'name': 'Demo Sector B Depot',
        'type': 'rectangle',
        'coordinates': {
            'north': 30.132456,
            'south': 30.128456,
            'east': 78.135456,
            'west': 78.129456
        },
        'radius': None,
        'status': 'active',
        'color': '#10b981',
        'description': 'Auto-generated demo logistics facility perimeter with vehicle tracking',
        'created_at': '2026-09-28T12:01:00.000Z',
        'updated_at': '2026-09-28T12:01:00.000Z'
    },
    {
        'id': 'geo_default_headquarters',
        'name': 'Headquarters Security Zone',
        'type': 'circle',
        'coordinates': {'lat': 30.118000, 'lng': 78.115000},
        'radius': 200.0,
        'status': 'active',
        'color': '#8b5cf6',
        'description': 'Primary facility security perimeter (200m zone)',
        'created_at': '2026-09-28T12:02:00.000Z',
        'updated_at': '2026-09-28T12:02:00.000Z'
    }
]

# -----------------------------------------------------------------------------
# MONGODB CONNECTION & AUTO-SEEDING
# -----------------------------------------------------------------------------

def seed_sample_data_in_mongodb():
    """Seeds sample geofences and initial ENTER/EXIT footprints directly into MongoDB."""
    global mongo_simulation_db, mongo_dummy_db
    if mongo_simulation_db is None:
        return

    now = datetime.utcnow().isoformat() + 'Z'

    # 1. Seed Sample Geofences into simulation_data_db.geofences if empty
    fence_count = mongo_simulation_db.geofences.count_documents({})
    if fence_count == 0:
        for f in SAMPLE_GEOFENCES:
            f_copy = dict(f)
            f_copy['updated_at'] = now
            mongo_simulation_db.geofences.replace_one({'id': f_copy['id']}, f_copy, upsert=True)
            in_memory_geofences[f_copy['id']] = f_copy
        print(f">> [MongoDB] Seeded {len(SAMPLE_GEOFENCES)} sample geofences into '{MONGODB_SIMULATION_DB}.geofences'")
    else:
        for doc in mongo_simulation_db.geofences.find({}, {'_id': 0}):
            in_memory_geofences[doc['id']] = doc

    # 2. Seed initial Simulation Footprints into simulation_data_db.simulation_footprints if empty
    if mongo_simulation_db.simulation_footprints.count_documents({}) == 0:
        sim_seeds = [
            {
                'id': 'sim_seed_alpha_enter',
                'device_id': 'PATROL_ALPHA',
                'geofence_id': 'geo_demo_alpha',
                'geofence_name': 'Demo Alpha Perimeter',
                'latitude': 30.123456,
                'longitude': 78.123456,
                'event': 'ENTER',
                'color': '#2563eb',
                'source': 'simulation_loop',
                'database': MONGODB_SIMULATION_DB,
                'collection': 'simulation_footprints',
                'created_at': (datetime.utcnow() - timedelta(minutes=2)).isoformat() + 'Z'
            },
            {
                'id': 'sim_seed_alpha_inside',
                'device_id': 'PATROL_ALPHA',
                'geofence_id': 'geo_demo_alpha',
                'geofence_name': 'Demo Alpha Perimeter',
                'latitude': 30.124200,
                'longitude': 78.123800,
                'event': 'INSIDE',
                'color': '#2563eb',
                'source': 'simulation_loop',
                'database': MONGODB_SIMULATION_DB,
                'collection': 'simulation_footprints',
                'created_at': (datetime.utcnow() - timedelta(minutes=1)).isoformat() + 'Z'
            }
        ]
        mongo_simulation_db.simulation_footprints.insert_many(sim_seeds)
        print(f">> [MongoDB] Seeded initial simulation footprints into '{MONGODB_SIMULATION_DB}.simulation_footprints'")

    # 3. Seed initial Dummy Footprints with ENTER, INSIDE, and EXIT into dummy_data_db if empty
    if mongo_dummy_db is not None and mongo_dummy_db.dummy_footprints.count_documents({}) == 0:
        dummy_seeds = [
            {
                'id': 'dummy_seed_depot_enter',
                'device_id': 'SCOUT_UNIT_02',
                'geofence_id': 'geo_demo_depot',
                'geofence_name': 'Demo Sector B Depot',
                'latitude': 30.128456,
                'longitude': 78.129456,
                'event': 'ENTER',
                'color': '#10b981',
                'source': 'area_dummy_generator',
                'database': MONGODB_DUMMY_DB,
                'collection': 'dummy_footprints',
                'created_at': (datetime.utcnow() - timedelta(minutes=3)).isoformat() + 'Z'
            },
            {
                'id': 'dummy_seed_depot_inside',
                'device_id': 'SCOUT_UNIT_02',
                'geofence_id': 'geo_demo_depot',
                'geofence_name': 'Demo Sector B Depot',
                'latitude': 30.130456,
                'longitude': 78.132456,
                'event': 'INSIDE',
                'color': '#10b981',
                'source': 'area_dummy_generator',
                'database': MONGODB_DUMMY_DB,
                'collection': 'dummy_footprints',
                'created_at': (datetime.utcnow() - timedelta(minutes=2)).isoformat() + 'Z'
            },
            {
                'id': 'dummy_seed_depot_exit',
                'device_id': 'SCOUT_UNIT_02',
                'geofence_id': 'geo_demo_depot',
                'geofence_name': 'Demo Sector B Depot',
                'latitude': 30.132456,
                'longitude': 78.135456,
                'event': 'EXIT',
                'color': '#10b981',
                'source': 'area_dummy_generator',
                'database': MONGODB_DUMMY_DB,
                'collection': 'dummy_footprints',
                'created_at': (datetime.utcnow() - timedelta(minutes=1)).isoformat() + 'Z'
            }
        ]
        mongo_dummy_db.dummy_footprints.insert_many(dummy_seeds)
        print(f">> [MongoDB] Seeded initial dummy [ENTER, INSIDE, EXIT] records into '{MONGODB_DUMMY_DB}.dummy_footprints'")

def init_mongo_connection(silent=False):
    """Initializes connection to MongoDB Atlas / Compass. MongoDB is the sole database."""
    global mongo_client, mongo_simulation_db, mongo_dummy_db, use_mongodb, mongo_connection_error

    if pymongo is None:
        mongo_connection_error = "Python package 'pymongo' is not installed. Please run: pip install pymongo dnspython"
        if not silent:
            print(f">> [MongoDB Error] {mongo_connection_error}")
        return False

    candidates = [MONGODB_URI]
    if '://Nitin:' in MONGODB_URI:
        candidates.append(MONGODB_URI.replace('://Nitin:', '://nitin:'))
    elif '://nitin:' in MONGODB_URI:
        candidates.append(MONGODB_URI.replace('://nitin:', '://Nitin:'))

    if 'localhost' in MONGODB_URI:
        candidates.append(MONGODB_URI.replace('localhost', '127.0.0.1'))

    last_error = None
    for uri in candidates:
        try:
            timeout_ms = 12000 if 'mongodb+srv' in uri else 3000
            client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=timeout_ms)
            client.admin.command('ping')
            mongo_client = client
            mongo_simulation_db = client[MONGODB_SIMULATION_DB]
            mongo_dummy_db = client[MONGODB_DUMMY_DB]
            use_mongodb = True
            mongo_connection_error = None

            # Setup indexes on MongoDB collections
            mongo_simulation_db.geofences.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index([('created_at', pymongo.DESCENDING)])

            mongo_dummy_db.dummy_footprints.create_index('id', unique=True)
            mongo_dummy_db.dummy_footprints.create_index([('created_at', pymongo.DESCENDING)])

            print(">> [MongoDB] ==================================================")
            print(">> [MongoDB] Live MongoDB Connection Active!")
            print(f">> [MongoDB] 1. Simulation DB (Live data & mouse): '{MONGODB_SIMULATION_DB}'")
            print(f">> [MongoDB]    Collections: 'geofences', 'simulation_footprints'")
            print(f">> [MongoDB] 2. Dummy Data DB (Area ENTER/EXIT):   '{MONGODB_DUMMY_DB}'")
            print(f">> [MongoDB]    Collections: 'dummy_footprints'")
            print(f">> [MongoDB] Connected URI: {uri}")
            print(">> [MongoDB] ==================================================")

            # Seed sample data into MongoDB
            seed_sample_data_in_mongodb()
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

def start_mongo_heartbeat():
    """Background reconnect daemon to maintain persistent connection to MongoDB."""
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
    init_mongo_connection()
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

def db_list_geofences():
    """Lists all geofences directly from MongoDB simulation_data_db.geofences."""
    if use_mongodb and mongo_simulation_db is not None:
        try:
            docs = list(mongo_simulation_db.geofences.find({}, {'_id': 0}).sort('created_at', -1))
            for d in docs:
                in_memory_geofences[d['id']] = d
            return docs
        except Exception as e:
            print(f">> [MongoDB Read Error] {e}")
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

def db_seed_sample_geofences():
    """Explicitly seeds/resets sample geofences directly into MongoDB."""
    now = datetime.utcnow().isoformat() + 'Z'
    results = []
    for f in SAMPLE_GEOFENCES:
        f_copy = dict(f)
        f_copy['updated_at'] = now
        in_memory_geofences[f_copy['id']] = f_copy
        if use_mongodb and mongo_simulation_db is not None:
            try:
                mongo_simulation_db.geofences.replace_one({'id': f_copy['id']}, f_copy, upsert=True)
            except Exception as e:
                print(f">> [MongoDB Seed Error] {e}")
        results.append(f_copy)
    return results

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

    return {
        'device_id': device_id,
        'coordinate': {'latitude': lat, 'longitude': lng},
        'inside_geofences': inside_details,
        'events': events
    }

# -----------------------------------------------------------------------------
# FOOTPRINT RECORDING & MONGODB DISPATCHER
# -----------------------------------------------------------------------------

def db_record_footprint(data):
    """
    Stores footprint records exclusively in MongoDB:
      - Dummy area records (source == 'area_dummy_generator' or dummy in source) -> dummy_data_db.dummy_footprints
      - Mouse data & simulation records -> simulation_data_db.simulation_footprints
    """
    fid = data.get('id') or f"fp_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}"
    now = datetime.utcnow().isoformat() + 'Z'
    device_id = str(data.get('device_id', 'MOUSE_POINTER'))
    geofence_id = data.get('geofence_id')
    geofence_name = data.get('geofence_name')
    latitude = float(data.get('latitude', 0.0))
    longitude = float(data.get('longitude', 0.0))
    event = str(data.get('event', 'INSIDE')).upper()
    source = str(data.get('source', 'mouse_live_telemetry'))

    is_dummy = (source == 'area_dummy_generator' or 'dummy' in source.lower() or data.get('is_dummy'))
    target_db_name = MONGODB_DUMMY_DB if is_dummy else MONGODB_SIMULATION_DB
    target_coll_name = 'dummy_footprints' if is_dummy else 'simulation_footprints'

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
        'database': target_db_name,
        'collection': target_coll_name,
        'created_at': now
    }

    # Store in memory cache
    if is_dummy:
        in_memory_dummy_footprints.insert(0, record)
        if len(in_memory_dummy_footprints) > 300:
            in_memory_dummy_footprints.pop()
    else:
        in_memory_simulation_footprints.insert(0, record)
        if len(in_memory_simulation_footprints) > 300:
            in_memory_simulation_footprints.pop()

    # Store in MongoDB (Atlas & Compass)
    if use_mongodb:
        try:
            doc = dict(record)
            doc.pop('_id', None)
            if is_dummy and mongo_dummy_db is not None:
                mongo_dummy_db.dummy_footprints.insert_one(doc)
            elif mongo_simulation_db is not None:
                mongo_simulation_db.simulation_footprints.insert_one(doc)
        except Exception as e:
            print(f">> [MongoDB Footprint Write Error] {e}")

    return record

def db_list_footprints(limit=50, target='all'):
    """Lists footprints directly from MongoDB simulation & dummy databases."""
    docs = []
    limit = int(limit)

    if use_mongodb:
        try:
            if target in ('all', 'simulation') and mongo_simulation_db is not None:
                sim_docs = list(mongo_simulation_db.simulation_footprints.find({}, {'_id': 0}).sort('created_at', -1).limit(limit))
                for d in sim_docs:
                    d['database'] = MONGODB_SIMULATION_DB
                    d['collection'] = 'simulation_footprints'
                docs.extend(sim_docs)
            if target in ('all', 'dummy') and mongo_dummy_db is not None:
                dummy_docs = list(mongo_dummy_db.dummy_footprints.find({}, {'_id': 0}).sort('created_at', -1).limit(limit))
                for d in dummy_docs:
                    d['database'] = MONGODB_DUMMY_DB
                    d['collection'] = 'dummy_footprints'
                docs.extend(dummy_docs)
            docs.sort(key=lambda x: x.get('created_at', ''), reverse=True)
            return docs[:limit]
        except Exception as e:
            print(f">> [MongoDB List Footprints Error] {e}")

    # Fallback to in-memory store
    if target in ('all', 'simulation'):
        docs.extend(in_memory_simulation_footprints[:limit])
    if target in ('all', 'dummy'):
        docs.extend(in_memory_dummy_footprints[:limit])
    docs.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    return docs[:limit]

def db_clear_footprints():
    """Clears footprints directly from MongoDB simulation & dummy collections."""
    in_memory_simulation_footprints.clear()
    in_memory_dummy_footprints.clear()

    if use_mongodb:
        try:
            if mongo_simulation_db is not None:
                mongo_simulation_db.simulation_footprints.delete_many({})
            if mongo_dummy_db is not None:
                mongo_dummy_db.dummy_footprints.delete_many({})
        except Exception as e:
            print(f">> [MongoDB Clear Footprints Error] {e}")

    return True

def get_database_status():
    """Returns database status. Exclusively reports MongoDB state."""
    sim_fences = 0
    sim_footprints = 0
    dummy_footprints = 0

    if use_mongodb and mongo_client is not None:
        try:
            if mongo_simulation_db is not None:
                sim_fences = mongo_simulation_db.geofences.count_documents({})
                sim_footprints = mongo_simulation_db.simulation_footprints.count_documents({})
            if mongo_dummy_db is not None:
                dummy_footprints = mongo_dummy_db.dummy_footprints.count_documents({})
        except Exception:
            sim_fences = len(in_memory_geofences)
            sim_footprints = len(in_memory_simulation_footprints)
            dummy_footprints = len(in_memory_dummy_footprints)
    else:
        sim_fences = len(in_memory_geofences)
        sim_footprints = len(in_memory_simulation_footprints)
        dummy_footprints = len(in_memory_dummy_footprints)

    return {
        'active_database': 'MongoDB Atlas & Compass',
        'active_engine': 'MongoDB',
        'mongodb_connected': use_mongodb,
        'mongodb_uri': MONGODB_URI,
        'compass_connection_string': MONGODB_URI,
        'mongodb_database': MONGODB_SIMULATION_DB,
        'simulation_database': MONGODB_SIMULATION_DB,
        'dummy_database': MONGODB_DUMMY_DB,
        'connection_error': mongo_connection_error,
        'databases': {
            'simulation_db': {
                'name': MONGODB_SIMULATION_DB,
                'type': 'Stored Simulation, Telemetry, Mouse & Sample Geofences',
                'collections': ['geofences', 'simulation_footprints'],
                'geofences_count': sim_fences,
                'footprints_count': sim_footprints
            },
            'dummy_db': {
                'name': MONGODB_DUMMY_DB,
                'type': 'Generated Dummy Area Footprints (ENTER/INSIDE/EXIT)',
                'collections': ['dummy_footprints'],
                'footprints_count': dummy_footprints
            }
        },
        'geofences_count': sim_fences,
        'footprints_count': sim_footprints + dummy_footprints,
        'simulation_footprints_count': sim_footprints,
        'dummy_footprints_count': dummy_footprints
    }

# -----------------------------------------------------------------------------
# DUMMY ENTRY/EXIT MOVEMENT ENGINE (STORED IN MONGODB)
# -----------------------------------------------------------------------------

def generate_dummy_movement_sequence(fence, device_id):
    """
    Generates a full movement sequence [ENTER, INSIDE, EXIT] for a given geofence:
      - ENTER: Exact entry coordinate crossing into the perimeter
      - INSIDE: Mid-point strictly inside the geofence zone
      - EXIT: Coordinate crossing out of the geofence perimeter
    """
    coords = fence.get('coordinates')
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            return []
    if not coords:
        return []

    ftype = fence.get('type')
    enter_pt = None
    inside_pt = None
    exit_pt = None

    if ftype == 'circle':
        center_lat = float(coords['lat'])
        center_lng = float(coords['lng'])
        radius = float(fence.get('radius') or 200.0)

        theta_enter = random.random() * 2 * math.pi
        theta_exit = (theta_enter + math.pi + (random.random() - 0.5) * 0.8) % (2 * math.pi)
        theta_inside = (theta_enter + (random.random() * 0.8 + 0.2) * math.pi) % (2 * math.pi)

        # 1. ENTER: On boundary edge
        r_enter = radius * 0.98
        d_lat_en = (r_enter * math.cos(theta_enter)) / 111320.0
        d_lng_en = (r_enter * math.sin(theta_enter)) / (111320.0 * math.cos(math.radians(center_lat)))
        enter_pt = {'lat': round(center_lat + d_lat_en, 6), 'lng': round(center_lng + d_lng_en, 6)}

        # 2. INSIDE: Core interior
        r_in = radius * (0.3 + 0.45 * random.random())
        d_lat_in = (r_in * math.cos(theta_inside)) / 111320.0
        d_lng_in = (r_in * math.sin(theta_inside)) / (111320.0 * math.cos(math.radians(center_lat)))
        inside_pt = {'lat': round(center_lat + d_lat_in, 6), 'lng': round(center_lng + d_lng_in, 6)}

        # 3. EXIT: Crossing boundary out
        r_exit = radius * 1.02
        d_lat_ex = (r_exit * math.cos(theta_exit)) / 111320.0
        d_lng_ex = (r_exit * math.sin(theta_exit)) / (111320.0 * math.cos(math.radians(center_lat)))
        exit_pt = {'lat': round(center_lat + d_lat_ex, 6), 'lng': round(center_lng + d_lng_ex, 6)}

    elif ftype == 'rectangle':
        north = float(coords['north'])
        south = float(coords['south'])
        east = float(coords['east'])
        west = float(coords['west'])
        lat_span = north - south
        lng_span = east - west

        # 1. ENTER: on west edge
        enter_pt = {
            'lat': round(south + lat_span * (0.2 + 0.6 * random.random()), 6),
            'lng': round(west + lng_span * 0.02, 6)
        }
        # 2. INSIDE: center
        inside_pt = {
            'lat': round(south + lat_span * (0.35 + 0.3 * random.random()), 6),
            'lng': round(west + lng_span * (0.35 + 0.3 * random.random()), 6)
        }
        # 3. EXIT: on east edge
        exit_pt = {
            'lat': round(south + lat_span * (0.2 + 0.6 * random.random()), 6),
            'lng': round(east + lng_span * 0.02, 6)
        }

    elif ftype == 'polygon':
        pts = coords
        if isinstance(pts, list) and len(pts) >= 3:
            # 1. ENTER on first boundary edge
            p0, p1 = pts[0], pts[1]
            enter_pt = {'lat': round(p0[0] + (p1[0] - p0[0]) * 0.5, 6), 'lng': round(p0[1] + (p1[1] - p0[1]) * 0.5, 6)}

            # 2. INSIDE centroid
            avg_lat = sum(p[0] for p in pts) / len(pts)
            avg_lng = sum(p[1] for p in pts) / len(pts)
            inside_pt = {'lat': round(avg_lat, 6), 'lng': round(avg_lng, 6)}

            # 3. EXIT on opposite edge
            mid_idx = len(pts) // 2
            pe1, pe2 = pts[mid_idx], pts[(mid_idx + 1) % len(pts)]
            exit_pt = {'lat': round(pe1[0] + (pe2[0] - pe1[0]) * 0.5, 6), 'lng': round(pe1[1] + (pe2[1] - pe1[1]) * 0.5, 6)}

    if not enter_pt or not inside_pt or not exit_pt:
        return []

    return [
        {'point': enter_pt, 'event': 'ENTER'},
        {'point': inside_pt, 'event': 'INSIDE'},
        {'point': exit_pt, 'event': 'EXIT'}
    ]

def generate_dummy_footprints_in_area(count=5, specific_fence_id=None, client_fences=None):
    """
    Generates dummy movement sequences including ENTER, INSIDE, and EXIT events,
    and stores all of them directly in MongoDB 'dummy_data_db.dummy_footprints'.
    """
    all_fences = db_list_geofences()

    # If DB is empty but client provided geofences, save them to MongoDB
    if not all_fences and client_fences and isinstance(client_fences, list):
        for cf in client_fences:
            try:
                db_create_geofence(cf)
            except Exception:
                pass
        all_fences = db_list_geofences()

    # If still completely empty, seed sample demo geofences in MongoDB
    if not all_fences:
        all_fences = db_seed_sample_geofences()

    active_fences = [f for f in all_fences if f.get('status') == 'active']
    if not active_fences:
        active_fences = all_fences

    if specific_fence_id:
        matched = [f for f in active_fences if f.get('id') == specific_fence_id]
        if matched:
            active_fences = matched

    if not active_fences:
        return []

    device_names = ['PATROL_ALPHA', 'SCOUT_UNIT_02', 'FIELD_RANGER_7', 'DRONE_SURVEILLANCE', 'LOGISTICS_TRUCK_8']
    generated_records = []

    # Number of patrol units to simulate (at least 1, up to count)
    num_units = max(1, min(int(count), len(device_names)))

    for i in range(num_units):
        fence = active_fences[i % len(active_fences)]
        device_id = device_names[i % len(device_names)]
        color = fence.get('color') or '#2563eb'

        sequence = generate_dummy_movement_sequence(fence, device_id)
        for step in sequence:
            rec = db_record_footprint({
                'device_id': device_id,
                'geofence_id': fence['id'],
                'geofence_name': fence['name'],
                'latitude': step['point']['lat'],
                'longitude': step['point']['lng'],
                'event': step['event'],
                'color': color,
                'source': 'area_dummy_generator'
            })
            rec['color'] = color
            generated_records.append(rec)

    return generated_records

# -----------------------------------------------------------------------------
# ENGINE 1: FLASK WEB ENGINE
# -----------------------------------------------------------------------------

def run_flask():
    from flask import Flask, request, jsonify, send_from_directory
    app = Flask(__name__, static_folder='.', static_url_path='')

    @app.after_request
    def cors(resp):
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        return resp

    @app.route('/api/geofences', methods=['GET'])
    def api_get():
        return jsonify(db_list_geofences())

    @app.route('/api/geofences', methods=['POST'])
    def api_post():
        data = request.get_json(force=True)
        return jsonify(db_create_geofence(data)), 201

    @app.route('/api/geofences/sample', methods=['POST'])
    def api_seed_sample():
        """Seeds and restores sample demo geofences directly in MongoDB."""
        return jsonify(db_seed_sample_geofences()), 201

    @app.route('/api/geofences/<fid>', methods=['PUT'])
    def api_put(fid):
        data = request.get_json(force=True)
        res = db_update_geofence(fid, data)
        return jsonify(res) if res else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences/<fid>', methods=['DELETE'])
    def api_del(fid):
        return jsonify({'success': True}) if db_delete_geofence(fid) else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences/<fid>/toggle', methods=['POST'])
    def api_tog(fid):
        res = db_toggle_geofence(fid)
        return jsonify(res) if res else (jsonify({'error': 'Not found'}), 404)

    @app.route('/api/geofences', methods=['DELETE'])
    def api_clear():
        db_clear_all()
        return jsonify({'success': True})

    @app.route('/api/geofences/export', methods=['GET'])
    def api_export():
        return jsonify(db_export_geojson())

    @app.route('/api/telemetry/evaluate', methods=['POST'])
    def api_telemetry():
        data = request.get_json(force=True)
        return jsonify(evaluate_telemetry(data))

    @app.route('/api/footprints', methods=['GET'])
    def api_get_footprints():
        limit = request.args.get('limit', 50)
        target = request.args.get('target', 'all')
        return jsonify(db_list_footprints(limit, target))

    @app.route('/api/footprints', methods=['POST'])
    def api_post_footprint():
        data = request.get_json(force=True)
        return jsonify(db_record_footprint(data)), 201

    @app.route('/api/footprints', methods=['DELETE'])
    def api_delete_footprints():
        db_clear_footprints()
        return jsonify({'success': True})

    @app.route('/api/simulation/generate', methods=['POST'])
    def api_generate_dummy():
        data = request.get_json(force=True) or {}
        count = data.get('count', 3)
        fence_id = data.get('geofence_id')
        client_fences = data.get('client_fences') or data.get('fences')
        records = generate_dummy_footprints_in_area(count, fence_id, client_fences)
        return jsonify(records)

    @app.route('/api/database/status', methods=['GET'])
    def api_db_status():
        if not use_mongodb:
            init_mongo_connection(silent=True)
        return jsonify(get_database_status())

    @app.route('/')
    def root():
        return send_from_directory('.', 'index.html')

    @app.route('/<path:p>')
    def files(p):
        return send_from_directory('.', p)

    app.run(host='0.0.0.0', port=PORT, debug=False)

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
            elif path == '/api/footprints':
                qs = urllib.parse.parse_qs(parsed.query)
                limit = int(qs.get('limit', [50])[0])
                target = qs.get('target', ['all'])[0]
                self.send_json(db_list_footprints(limit, target))
            elif path == '/api/geofences/export':
                self.send_json(db_export_geojson())
            else:
                if path == '/':
                    self.path = '/index.html'
                super().do_GET()

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            body = self.read_json_body()

            if path == '/api/geofences':
                created = db_create_geofence(body)
                self.send_json(created, status=201)
            elif path == '/api/geofences/sample':
                self.send_json(db_seed_sample_geofences(), status=201)
            elif path == '/api/footprints':
                created = db_record_footprint(body)
                self.send_json(created, status=201)
            elif path == '/api/simulation/generate':
                count = body.get('count', 3) if isinstance(body, dict) else 3
                fence_id = body.get('geofence_id') if isinstance(body, dict) else None
                client_fences = (body.get('client_fences') or body.get('fences')) if isinstance(body, dict) else None
                self.send_json(generate_dummy_footprints_in_area(count, fence_id, client_fences))
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
        print(f">> 1. Simulation DB (Live data, mouse, fences): '{db_stat.get('simulation_database')}'")
        print(f">>    Collections: 'geofences', 'simulation_footprints'")
        print(f">> 2. Dummy Data DB (Area ENTER/INSIDE/EXIT):   '{db_stat.get('dummy_database')}'")
        print(f">>    Collections: 'dummy_footprints'")
    else:
        print(f">> MongoDB Connecting... Target URI: {MONGODB_URI}")
    print(f">> Serving Dashboard at: http://localhost:{PORT}")
    print("=" * 64)

    try:
        import flask
        print(">> Web Engine: Flask Active")
        run_flask()
    except ImportError:
        print(">> Web Engine: Built-in Python HTTP Engine (Flask not in this environment)")
        run_builtin()
