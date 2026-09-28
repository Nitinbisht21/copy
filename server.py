"""
Geofence Map Builder - Python Backend
Provides:
  - MongoDB & MongoDB Compass integration (primary persistent store)
  - Persistent SQLite fallback ('geofences.db')
  - Full REST API (/api/geofences, /api/geofences/<id>, /api/geofences/export, /api/database/status, etc.)
  - Real-time GPS Telemetry Evaluation Engine (/api/telemetry/evaluate)
  - Footprint Recording & Live Event Logging ('footprints.log')
  - Static file serving for the frontend dashboard
  - Dual Engine: Uses Flask if available; falls back automatically to built-in http.server
"""

import os
import sys
import json
import math
import random
import uuid
import sqlite3
import threading
import time
from datetime import datetime

# Load environment variables (.env)
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
MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017/')
MONGODB_SIMULATION_DB = os.environ.get('MONGODB_SIMULATION_DB', 'simulation_data_db')
MONGODB_DUMMY_DB = os.environ.get('MONGODB_DUMMY_DB', 'dummy_data_db')
MONGODB_DB_NAME = MONGODB_SIMULATION_DB
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geofences.db')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
FOOTPRINTS_LOG_PATH = os.path.join(STATIC_DIR, 'footprints.log')
EARTH_RADIUS_METERS = 6371008.8

mongo_client = None
mongo_simulation_db = None  # DB 1: Live simulation & perimeter stored data
mongo_dummy_db = None       # DB 2: Generated dummy area data
mongo_db = None             # Fallback alias pointing to simulation db
use_mongodb = False
device_last_known_geofences = {}

# -----------------------------------------------------------------------------
# DATABASE INITIALIZATION: SQLITE & MONGODB COMPASS INTEGRATION
# -----------------------------------------------------------------------------

def get_sqlite_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def sqlite_init_db():
    conn = get_sqlite_connection()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS geofences (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            coordinates TEXT NOT NULL,
            radius REAL,
            status TEXT NOT NULL DEFAULT 'active',
            color TEXT DEFAULT '#2563eb',
            description TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS simulation_footprints (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            geofence_id TEXT,
            geofence_name TEXT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            event TEXT NOT NULL,
            color TEXT DEFAULT '#2563eb',
            source TEXT DEFAULT 'simulation_loop',
            created_at TEXT NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS dummy_footprints (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            geofence_id TEXT,
            geofence_name TEXT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            event TEXT NOT NULL,
            color TEXT DEFAULT '#2563eb',
            source TEXT DEFAULT 'area_dummy_generator',
            created_at TEXT NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS footprints (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            geofence_id TEXT,
            geofence_name TEXT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            event TEXT NOT NULL,
            source TEXT DEFAULT 'simulation',
            created_at TEXT NOT NULL
        )
    ''')

    if not os.path.exists(FOOTPRINTS_LOG_PATH):
        try:
            with open(FOOTPRINTS_LOG_PATH, 'w', encoding='utf-8') as f:
                f.write(f"# Footprint Activity Log Initialized at {datetime.utcnow().isoformat()}Z\n")
        except Exception:
            pass

    cursor.execute('SELECT COUNT(*) FROM geofences')
    count = cursor.fetchone()[0]
    if count == 0:
        now = datetime.utcnow().isoformat() + 'Z'
        default_fence = (
            'geo_default_headquarters',
            'Headquarters Perimeter',
            'circle',
            json.dumps({'lat': 30.123456, 'lng': 78.123456}),
            200.0,
            'active',
            '#2563eb',
            'Primary facility security perimeter (200m zone)',
            now,
            now
        )
        cursor.execute('''
            INSERT INTO geofences (id, name, type, coordinates, radius, status, color, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', default_fence)
        conn.commit()

    conn.close()

def init_mongo_connection(silent=False):
    global mongo_client, mongo_simulation_db, mongo_dummy_db, mongo_db, use_mongodb
    if pymongo is None:
        if not silent:
            print(">> [Database Notice] 'pymongo' not installed. Running on SQLite.")
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
            timeout_ms = 12000 if 'mongodb+srv' in uri else 2500
            client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=timeout_ms)
            client.admin.command('ping')
            mongo_client = client
            mongo_simulation_db = client[MONGODB_SIMULATION_DB]
            mongo_dummy_db = client[MONGODB_DUMMY_DB]
            mongo_db = mongo_simulation_db
            use_mongodb = True

            # 1. Setup Simulation DB
            mongo_simulation_db.geofences.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index('id', unique=True)
            mongo_simulation_db.simulation_footprints.create_index([('created_at', pymongo.DESCENDING)])

            # 2. Setup Dummy DB
            mongo_dummy_db.dummy_footprints.create_index('id', unique=True)
            mongo_dummy_db.dummy_footprints.create_index([('created_at', pymongo.DESCENDING)])

            print(">> [Database] ==================================================")
            print(">> [Database] Dual MongoDB Databases Active!")
            print(f">> [Database] 1. Simulation DB (stored data): '{MONGODB_SIMULATION_DB}'")
            print(f">> [Database]    Collections: 'geofences', 'simulation_footprints'")
            print(f">> [Database] 2. Dummy Data DB:              '{MONGODB_DUMMY_DB}'")
            print(f">> [Database]    Collections: 'dummy_footprints'")
            print(f">> [Database] Connected URI: {uri}")
            print(">> [Database] ==================================================")

            # Migrate geofences into Simulation DB if empty
            if mongo_simulation_db.geofences.count_documents({}) == 0:
                existing_fences = sqlite_list_geofences()
                if existing_fences:
                    for f in existing_fences:
                        clean_f = dict(f)
                        clean_f.pop('_id', None)
                        mongo_simulation_db.geofences.insert_one(clean_f)
                    print(f">> [Database] Migrated {len(existing_fences)} geofence(s) to Simulation DB '{MONGODB_SIMULATION_DB}'!")
                else:
                    now = datetime.utcnow().isoformat() + 'Z'
                    mongo_simulation_db.geofences.insert_one({
                        'id': 'geo_default_headquarters',
                        'name': 'Headquarters Perimeter',
                        'type': 'circle',
                        'coordinates': {'lat': 30.123456, 'lng': 78.123456},
                        'radius': 200.0,
                        'status': 'active',
                        'color': '#2563eb',
                        'description': 'Primary facility security perimeter (200m zone)',
                        'created_at': now,
                        'updated_at': now
                    })
                    print(f">> [Database] Seeded initial default geofence into '{MONGODB_SIMULATION_DB}.geofences'")

            # Initialize Dummy DB collection so it appears immediately in Compass
            if mongo_dummy_db.dummy_footprints.count_documents({}) == 0:
                mongo_dummy_db.dummy_footprints.insert_one({
                    'id': 'dummy_seed_01',
                    'device_id': 'DUMMY_SCOUT_01',
                    'geofence_id': 'geo_default_headquarters',
                    'geofence_name': 'Headquarters Perimeter',
                    'latitude': 30.123456,
                    'longitude': 78.123456,
                    'event': 'INSIDE',
                    'color': '#2563eb',
                    'source': 'area_dummy_generator',
                    'note': 'Initial dummy footprint seed',
                    'created_at': datetime.utcnow().isoformat() + 'Z'
                })
                print(f">> [Database] Seeded initial dummy record into '{MONGODB_DUMMY_DB}.dummy_footprints'")
            return True
        except Exception as e:
            last_error = e
            continue

    use_mongodb = False
    if not silent:
        print(f">> [Database Notice] MongoDB connection failed: {last_error}")
        print(f">> [Database Notice] Running on local SQLite database (geofences.db).")
        print(f">> [Database Notice] In MongoDB Compass, open and connect to: {MONGODB_URI}")
    return False

def start_mongo_heartbeat():
    def heartbeat_loop():
        while True:
            time.sleep(8)
            if not use_mongodb:
                connected = init_mongo_connection(silent=True)
                if connected:
                    print(f">> [Database] Live connection to MongoDB established at {MONGODB_URI}!")
    t = threading.Thread(target=heartbeat_loop, daemon=True)
    t.start()

def init_db():
    sqlite_init_db()
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
        coords = json.loads(coords)

    if ftype == 'circle':
        center = (coords['lat'], coords['lng'])
        return is_point_in_circle(point, center, fence.get('radius', 0))
    elif ftype == 'rectangle':
        return is_point_in_rectangle(point, coords)
    elif ftype == 'polygon':
        return is_point_in_polygon(point, coords)
    return False

# -----------------------------------------------------------------------------
# 1. SQLITE PERSISTENCE LAYER (LOCAL DUAL-STORAGE / FALLBACK)
# -----------------------------------------------------------------------------

def row_to_dict(row):
    coords = row['coordinates']
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            pass

    return {
        'id': row['id'],
        'name': row['name'],
        'type': row['type'],
        'coordinates': coords,
        'radius': row['radius'],
        'status': row['status'],
        'color': row['color'],
        'description': row['description'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at']
    }

def sqlite_list_geofences():
    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('SELECT * FROM geofences ORDER BY created_at DESC')
    rows = c.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]

def sqlite_create_geofence(data):
    now = datetime.utcnow().isoformat() + 'Z'
    fence_id = data.get('id') or f"geo_{int(datetime.utcnow().timestamp()*1000)}"
    name = (data.get('name') or 'Unnamed Geofence').strip()
    ftype = data.get('type')
    coords = data.get('coordinates')
    radius = float(data.get('radius')) if ftype == 'circle' and data.get('radius') is not None else None
    status = data.get('status') or 'active'
    color = data.get('color') or '#2563eb'
    description = (data.get('description') or '').strip()
    coords_json = json.dumps(coords) if not isinstance(coords, str) else coords

    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('''
        INSERT OR REPLACE INTO geofences (id, name, type, coordinates, radius, status, color, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (fence_id, name, ftype, coords_json, radius, status, color, description, now, now))
    conn.commit()
    c.execute('SELECT * FROM geofences WHERE id = ?', (fence_id,))
    row = c.fetchone()
    conn.close()
    return row_to_dict(row)

def sqlite_update_geofence(fence_id, data):
    now = datetime.utcnow().isoformat() + 'Z'
    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('SELECT * FROM geofences WHERE id = ?', (fence_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return None

    existing = row_to_dict(row)
    name = (data.get('name') if 'name' in data else existing['name']).strip()
    ftype = data.get('type') if 'type' in data else existing['type']
    coords = data.get('coordinates') if 'coordinates' in data else existing['coordinates']
    radius = float(data['radius']) if 'radius' in data and data['radius'] is not None and ftype == 'circle' else (float(existing.get('radius') or 200) if ftype == 'circle' else None)
    status = data.get('status') if 'status' in data else existing['status']
    color = data.get('color') if 'color' in data else existing['color']
    description = (data.get('description') if 'description' in data else existing['description']).strip()
    coords_json = json.dumps(coords) if not isinstance(coords, str) else coords

    c.execute('''
        UPDATE geofences
        SET name = ?, type = ?, coordinates = ?, radius = ?, status = ?, color = ?, description = ?, updated_at = ?
        WHERE id = ?
    ''', (name, ftype, coords_json, radius, status, color, description, now, fence_id))
    conn.commit()
    c.execute('SELECT * FROM geofences WHERE id = ?', (fence_id,))
    updated = c.fetchone()
    conn.close()
    return row_to_dict(updated)

def sqlite_delete_geofence(fence_id):
    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('DELETE FROM geofences WHERE id = ?', (fence_id,))
    deleted = c.rowcount > 0
    conn.commit()
    conn.close()
    return deleted

def sqlite_toggle_geofence(fence_id):
    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('SELECT status FROM geofences WHERE id = ?', (fence_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return None

    new_status = 'disabled' if row['status'] == 'active' else 'active'
    now = datetime.utcnow().isoformat() + 'Z'
    c.execute('UPDATE geofences SET status = ?, updated_at = ? WHERE id = ?', (new_status, now, fence_id))
    conn.commit()
    c.execute('SELECT * FROM geofences WHERE id = ?', (fence_id,))
    updated = c.fetchone()
    conn.close()
    return row_to_dict(updated)

def sqlite_clear_all():
    conn = get_sqlite_connection()
    c = conn.cursor()
    c.execute('DELETE FROM geofences')
    conn.commit()
    conn.close()

def sqlite_record_footprint(record):
    conn = get_sqlite_connection()
    c = conn.cursor()
    is_dummy = (record.get('source') == 'area_dummy_generator' or 'dummy' in str(record.get('source', '')).lower())
    table = 'dummy_footprints' if is_dummy else 'simulation_footprints'
    c.execute(f'''
        INSERT OR REPLACE INTO {table} (id, device_id, geofence_id, geofence_name, latitude, longitude, event, color, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (record['id'], record['device_id'], record['geofence_id'], record['geofence_name'],
          record['latitude'], record['longitude'], record['event'], record.get('color', '#2563eb'), record['source'], record['created_at']))

    # Keep footprints table updated for legacy queries
    c.execute('''
        INSERT OR REPLACE INTO footprints (id, device_id, geofence_id, geofence_name, latitude, longitude, event, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (record['id'], record['device_id'], record['geofence_id'], record['geofence_name'],
          record['latitude'], record['longitude'], record['event'], record['source'], record['created_at']))
    conn.commit()
    conn.close()

def sqlite_list_footprints(limit=50, target='all'):
    conn = get_sqlite_connection()
    c = conn.cursor()
    rows = []

    if target in ('all', 'simulation'):
        try:
            c.execute('''
                SELECT f.*, g.color as fence_color, 'simulation_data_db' as database, 'simulation_footprints' as collection
                FROM simulation_footprints f
                LEFT JOIN geofences g ON f.geofence_id = g.id
                ORDER BY f.created_at DESC LIMIT ?
            ''', (int(limit),))
            for r in c.fetchall():
                d = dict(r)
                d['color'] = d.get('color') or d.get('fence_color') or '#2563eb'
                rows.append(d)
        except Exception:
            pass

    if target in ('all', 'dummy'):
        try:
            c.execute('''
                SELECT f.*, g.color as fence_color, 'dummy_data_db' as database, 'dummy_footprints' as collection
                FROM dummy_footprints f
                LEFT JOIN geofences g ON f.geofence_id = g.id
                ORDER BY f.created_at DESC LIMIT ?
            ''', (int(limit),))
            for r in c.fetchall():
                d = dict(r)
                d['color'] = d.get('color') or d.get('fence_color') or '#2563eb'
                rows.append(d)
        except Exception:
            pass

    # Fallback to general footprints table if empty
    if not rows:
        try:
            c.execute('''
                SELECT f.*, g.color as fence_color, 'simulation_data_db' as database, 'simulation_footprints' as collection
                FROM footprints f
                LEFT JOIN geofences g ON f.geofence_id = g.id
                ORDER BY f.created_at DESC LIMIT ?
            ''', (int(limit),))
            for r in c.fetchall():
                d = dict(r)
                d['color'] = d.get('fence_color') or '#2563eb'
                rows.append(d)
        except Exception:
            pass

    rows.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    conn.close()
    return rows[:int(limit)]

def sqlite_clear_footprints():
    conn = get_sqlite_connection()
    c = conn.cursor()
    try:
        c.execute('DELETE FROM simulation_footprints')
    except Exception:
        pass
    try:
        c.execute('DELETE FROM dummy_footprints')
    except Exception:
        pass
    try:
        c.execute('DELETE FROM footprints')
    except Exception:
        pass
    conn.commit()
    conn.close()

# -----------------------------------------------------------------------------
# 2. MONGODB PERSISTENCE LAYER (COMPASS COMPATIBLE DUAL DATABASES)
# -----------------------------------------------------------------------------

def mongo_list_geofences():
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    docs = db.geofences.find({}, {'_id': 0}).sort('created_at', -1)
    return list(docs)

def mongo_create_geofence(fence_dict):
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    doc = dict(fence_dict)
    doc.pop('_id', None)
    db.geofences.replace_one({'id': doc['id']}, doc, upsert=True)
    return doc

def mongo_update_geofence(fence_id, data):
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    existing = db.geofences.find_one({'id': fence_id}, {'_id': 0})
    if not existing:
        return None
    now = datetime.utcnow().isoformat() + 'Z'
    updated = dict(existing)
    for k in ['name', 'type', 'coordinates', 'radius', 'status', 'color', 'description']:
        if k in data:
            updated[k] = data[k]
    updated['updated_at'] = now
    db.geofences.replace_one({'id': fence_id}, updated)
    return updated

def mongo_delete_geofence(fence_id):
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    res = db.geofences.delete_one({'id': fence_id})
    return res.deleted_count > 0

def mongo_toggle_geofence(fence_id):
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    existing = db.geofences.find_one({'id': fence_id}, {'_id': 0})
    if not existing:
        return None
    new_status = 'disabled' if existing.get('status') == 'active' else 'active'
    now = datetime.utcnow().isoformat() + 'Z'
    existing['status'] = new_status
    existing['updated_at'] = now
    db.geofences.replace_one({'id': fence_id}, existing)
    return existing

def mongo_clear_all():
    db = mongo_simulation_db if mongo_simulation_db is not None else mongo_db
    db.geofences.delete_many({})

def mongo_record_footprint(record):
    is_dummy = (record.get('source') == 'area_dummy_generator' or 'dummy' in str(record.get('source', '')).lower())
    doc = dict(record)
    doc.pop('_id', None)
    if is_dummy and mongo_dummy_db is not None:
        mongo_dummy_db.dummy_footprints.insert_one(doc)
    elif mongo_simulation_db is not None:
        mongo_simulation_db.simulation_footprints.insert_one(doc)

def mongo_list_footprints(limit=50, target='all'):
    docs = []
    if target in ('all', 'simulation') and mongo_simulation_db is not None:
        sim_docs = list(mongo_simulation_db.simulation_footprints.find({}, {'_id': 0}).sort('created_at', -1).limit(int(limit)))
        for d in sim_docs:
            d['database'] = MONGODB_SIMULATION_DB
            d['collection'] = 'simulation_footprints'
        docs.extend(sim_docs)
    if target in ('all', 'dummy') and mongo_dummy_db is not None:
        dummy_docs = list(mongo_dummy_db.dummy_footprints.find({}, {'_id': 0}).sort('created_at', -1).limit(int(limit)))
        for d in dummy_docs:
            d['database'] = MONGODB_DUMMY_DB
            d['collection'] = 'dummy_footprints'
        docs.extend(dummy_docs)
    docs.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    return docs[:int(limit)]

def mongo_clear_footprints():
    if mongo_simulation_db is not None:
        mongo_simulation_db.simulation_footprints.delete_many({})
    if mongo_dummy_db is not None:
        mongo_dummy_db.dummy_footprints.delete_many({})

# -----------------------------------------------------------------------------
# 3. UNIFIED DATABASE DISPATCHER (MONGODB PRIMARY + SQLITE DUAL SYNC)
# -----------------------------------------------------------------------------

def db_list_geofences():
    if use_mongodb and mongo_db is not None:
        try:
            return mongo_list_geofences()
        except Exception as e:
            print(f">> [Database Warning] MongoDB read failed: {e}. Falling back to SQLite.")
    return sqlite_list_geofences()

def db_create_geofence(data):
    now = datetime.utcnow().isoformat() + 'Z'
    fence_id = data.get('id') or f"geo_{int(datetime.utcnow().timestamp()*1000)}"
    name = (data.get('name') or 'Unnamed Geofence').strip()
    ftype = data.get('type')
    coords = data.get('coordinates')
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

    # Save to SQLite
    sqlite_create_geofence(fence_dict)

    # Save to MongoDB if available
    if use_mongodb and mongo_db is not None:
        try:
            mongo_create_geofence(fence_dict)
        except Exception as e:
            print(f">> [Database Warning] MongoDB write failed: {e}")

    return fence_dict

def db_update_geofence(fence_id, data):
    sqlite_res = sqlite_update_geofence(fence_id, data)
    if use_mongodb and mongo_db is not None:
        try:
            mongo_res = mongo_update_geofence(fence_id, data)
            if mongo_res:
                return mongo_res
        except Exception as e:
            print(f">> [Database Warning] MongoDB update failed: {e}")
    return sqlite_res

def db_delete_geofence(fence_id):
    if use_mongodb and mongo_db is not None:
        try:
            mongo_delete_geofence(fence_id)
        except Exception:
            pass
    return sqlite_delete_geofence(fence_id)

def db_toggle_geofence(fence_id):
    sqlite_res = sqlite_toggle_geofence(fence_id)
    if use_mongodb and mongo_db is not None:
        try:
            mongo_res = mongo_toggle_geofence(fence_id)
            if mongo_res:
                return mongo_res
        except Exception:
            pass
    return sqlite_res

def db_clear_all():
    if use_mongodb and mongo_db is not None:
        try:
            mongo_clear_all()
        except Exception:
            pass
    sqlite_clear_all()

def db_export_geojson():
    fences = db_list_geofences()
    features = []
    for f in fences:
        geom = None
        if f['type'] == 'circle':
            geom = {'type': 'Point', 'coordinates': [f['coordinates']['lng'], f['coordinates']['lat']]}
        elif f['type'] == 'rectangle':
            c = f['coordinates']
            geom = {
                'type': 'Polygon',
                'coordinates': [[[c['west'], c['north']], [c['east'], c['north']], [c['east'], c['south']], [c['west'], c['south']], [c['west'], c['north']]]]
            }
        elif f['type'] == 'polygon':
            ring = [[pt[1], pt[0]] for pt in f['coordinates']]
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
    device_id = str(data.get('device_id', 'default_device'))
    lat = float(data['latitude'])
    lng = float(data['longitude'])
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
                'type': f['type']
            })

    previously_inside = device_last_known_geofences.get(device_id, set())
    device_last_known_geofences[device_id] = currently_inside

    events = []
    for fid in (currently_inside - previously_inside):
        events.append({
            'event': 'ENTER',
            'device_id': device_id,
            'geofence_id': fid,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        })
    for fid in (previously_inside - currently_inside):
        events.append({
            'event': 'EXIT',
            'device_id': device_id,
            'geofence_id': fid,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        })

    return {
        'device_id': device_id,
        'coordinate': {'latitude': lat, 'longitude': lng},
        'inside_geofences': inside_details,
        'events': events
    }

# -----------------------------------------------------------------------------
# FOOTPRINT RECORDING, LOGGING & DUMMY AREA DATA GENERATOR
# -----------------------------------------------------------------------------

def log_footprint_entry(entry):
    try:
        ts = entry.get('created_at') or datetime.utcnow().isoformat() + 'Z'
        device = entry.get('device_id', 'UNKNOWN_DEVICE')
        fence_name = entry.get('geofence_name') or 'N/A'
        event = entry.get('event', 'INSIDE')
        lat = entry.get('latitude', 0.0)
        lng = entry.get('longitude', 0.0)
        source = entry.get('source', 'general')

        line = f"[{ts}] [{event.upper()}] Device: {device} | Fence: {fence_name} | Lat: {float(lat):.6f}, Lng: {float(lng):.6f} | Source: {source}\n"
        with open(FOOTPRINTS_LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
            f.flush()
    except Exception as e:
        print(f">> Error logging footprint to file: {e}", file=sys.stderr)

def db_record_footprint(data):
    fid = data.get('id') or f"fp_{int(datetime.utcnow().timestamp()*1000)}_{uuid.uuid4().hex[:6]}"
    now = datetime.utcnow().isoformat() + 'Z'
    device_id = str(data.get('device_id', 'MOUSE_KEY'))
    geofence_id = data.get('geofence_id')
    geofence_name = data.get('geofence_name')
    latitude = float(data.get('latitude', 0.0))
    longitude = float(data.get('longitude', 0.0))
    event = str(data.get('event', 'INSIDE')).upper()
    source = str(data.get('source', 'simulation_loop'))

    is_dummy = (source == 'area_dummy_generator' or 'dummy' in source.lower() or data.get('is_dummy'))
    target_db_name = MONGODB_DUMMY_DB if is_dummy else MONGODB_SIMULATION_DB
    target_coll_name = 'dummy_footprints' if is_dummy else 'simulation_footprints'

    color = data.get('color')
    if not color and geofence_id:
        try:
            conn = get_sqlite_connection()
            c = conn.cursor()
            c.execute('SELECT color FROM geofences WHERE id = ?', (geofence_id,))
            row = c.fetchone()
            if row and row['color']:
                color = row['color']
            conn.close()
        except Exception:
            pass

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

    # Record in MongoDB
    if use_mongodb and mongo_client is not None:
        try:
            mongo_record_footprint(record)
        except Exception as e:
            print(f">> [Database Warning] MongoDB footprint write failed: {e}")

    # Record in SQLite & log file
    sqlite_record_footprint(record)
    log_footprint_entry(record)
    return record

def db_list_footprints(limit=50, target='all'):
    if use_mongodb and mongo_client is not None:
        try:
            return mongo_list_footprints(limit, target)
        except Exception:
            pass
    return sqlite_list_footprints(limit, target)

def db_clear_footprints():
    if use_mongodb and mongo_client is not None:
        try:
            mongo_clear_footprints()
        except Exception:
            pass
    sqlite_clear_footprints()
    try:
        with open(FOOTPRINTS_LOG_PATH, 'w', encoding='utf-8') as f:
            f.write(f"# Footprint Activity Log Reset at {datetime.utcnow().isoformat()}Z\n")
    except Exception:
        pass
    return True

def get_database_status():
    if use_mongodb and mongo_client is not None:
        sim_fences = mongo_simulation_db.geofences.count_documents({}) if mongo_simulation_db is not None else 0
        sim_footprints = mongo_simulation_db.simulation_footprints.count_documents({}) if mongo_simulation_db is not None else 0
        dummy_footprints = mongo_dummy_db.dummy_footprints.count_documents({}) if mongo_dummy_db is not None else 0
    else:
        conn = get_sqlite_connection()
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM geofences')
        sim_fences = c.fetchone()[0]
        try:
            c.execute('SELECT COUNT(*) FROM simulation_footprints')
            sim_footprints = c.fetchone()[0]
        except Exception:
            sim_footprints = 0
        try:
            c.execute('SELECT COUNT(*) FROM dummy_footprints')
            dummy_footprints = c.fetchone()[0]
        except Exception:
            dummy_footprints = 0
        conn.close()

    return {
        'active_database': 'MongoDB Dual' if use_mongodb else 'SQLite Dual',
        'active_engine': 'MongoDB' if use_mongodb else 'SQLite',
        'mongodb_connected': use_mongodb,
        'mongodb_uri': MONGODB_URI,
        'compass_connection_string': MONGODB_URI,
        'mongodb_database': MONGODB_SIMULATION_DB,
        'simulation_database': MONGODB_SIMULATION_DB,
        'dummy_database': MONGODB_DUMMY_DB,
        'databases': {
            'simulation_db': {
                'name': MONGODB_SIMULATION_DB,
                'type': 'Stored Simulation, Telemetry & Geofences',
                'collections': ['geofences', 'simulation_footprints'],
                'geofences_count': sim_fences,
                'footprints_count': sim_footprints
            },
            'dummy_db': {
                'name': MONGODB_DUMMY_DB,
                'type': 'Generated Dummy Area Footprints',
                'collections': ['dummy_footprints'],
                'footprints_count': dummy_footprints
            }
        },
        'geofences_count': sim_fences,
        'footprints_count': sim_footprints + dummy_footprints,
        'simulation_footprints_count': sim_footprints,
        'dummy_footprints_count': dummy_footprints
    }

def generate_dummy_point_inside_fence(fence):
    coords = fence.get('coordinates')
    if isinstance(coords, str):
        try:
            coords = json.loads(coords)
        except Exception:
            return None
    if not coords:
        return None

    ftype = fence.get('type')
    if ftype == 'circle':
        center_lat = float(coords['lat'])
        center_lng = float(coords['lng'])
        radius = float(fence.get('radius') or 200.0)
        # Random point inside 85% of radius to avoid boundary rounding issues
        r = (radius * 0.85) * math.sqrt(0.05 + 0.95 * random.random())
        theta = random.random() * 2 * math.pi
        d_lat = (r * math.cos(theta)) / 111320.0
        d_lng = (r * math.sin(theta)) / (111320.0 * math.cos(math.radians(center_lat)))
        return {'lat': round(center_lat + d_lat, 6), 'lng': round(center_lng + d_lng, 6)}

    elif ftype == 'rectangle':
        north = float(coords['north'])
        south = float(coords['south'])
        east = float(coords['east'])
        west = float(coords['west'])
        lat = south + (north - south) * (0.08 + 0.84 * random.random())
        lng = west + (east - west) * (0.08 + 0.84 * random.random())
        return {'lat': round(lat, 6), 'lng': round(lng, 6)}

    elif ftype == 'polygon':
        pts = coords
        if not isinstance(pts, list) or len(pts) < 3:
            return None
        lats = [p[0] for p in pts]
        lngs = [p[1] for p in pts]
        min_lat, max_lat = min(lats), max(lats)
        min_lng, max_lng = min(lngs), max(lngs)
        for _ in range(100):
            cand_lat = min_lat + (max_lat - min_lat) * random.random()
            cand_lng = min_lng + (max_lng - min_lng) * random.random()
            if is_point_in_polygon((cand_lat, cand_lng), pts):
                return {'lat': round(cand_lat, 6), 'lng': round(cand_lng, 6)}
        avg_lat = sum(lats) / len(lats)
        avg_lng = sum(lngs) / len(lngs)
        return {'lat': round(avg_lat, 6), 'lng': round(avg_lng, 6)}

    return None

def generate_dummy_footprints_in_area(count=5, specific_fence_id=None, client_fences=None):
    all_fences = db_list_geofences()
    
    # If DB is empty but client provided geofences, save them to DB
    if not all_fences and client_fences and isinstance(client_fences, list):
        for cf in client_fences:
            try:
                db_create_geofence(cf)
            except Exception:
                pass
        all_fences = db_list_geofences()

    # If still completely empty, auto-create a default sample geofence so dummy data always works
    if not all_fences:
        default_fence = {
            'name': 'Demo Security Perimeter Alpha',
            'type': 'circle',
            'coordinates': {'lat': 30.123456, 'lng': 78.123456},
            'radius': 350,
            'status': 'active',
            'color': '#2563eb',
            'description': 'Auto-generated demo area for dummy data simulation'
        }
        created = db_create_geofence(default_fence)
        all_fences = [created] if created else []

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

    for i in range(int(count)):
        fence = active_fences[i % len(active_fences)]
        pt = generate_dummy_point_inside_fence(fence)
        if pt:
            device_id = device_names[i % len(device_names)]
            color = fence.get('color') or '#2563eb'
            rec = db_record_footprint({
                'device_id': device_id,
                'geofence_id': fence['id'],
                'geofence_name': fence['name'],
                'latitude': pt['lat'],
                'longitude': pt['lng'],
                'event': 'INSIDE',
                'color': color,
                'source': 'area_dummy_generator'
            })
            rec['color'] = color
            generated_records.append(rec)

    return generated_records

# -----------------------------------------------------------------------------
# ENGINE 1: FLASK IMPLEMENTATION (When Flask is available)
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
        count = data.get('count', 5)
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
# ENGINE 2: BUILT-IN HTTP SERVER FALLBACK (Zero Dependencies)
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
            elif path == '/api/footprints':
                created = db_record_footprint(body)
                self.send_json(created, status=201)
            elif path == '/api/simulation/generate':
                count = body.get('count', 5) if isinstance(body, dict) else 5
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
    print(f">> Primary Engine: {db_stat['active_engine']}")
    if db_stat['mongodb_connected']:
        print(f">> MongoDB Compass URI: {db_stat['mongodb_uri']}")
        print(f">> 1. Simulation DB (Live data):  {db_stat.get('simulation_database')}")
        print(f">> 2. Dummy Data DB (Generated): {db_stat.get('dummy_database')}")
        print(f">> Compass Collections: geofences, simulation_footprints, dummy_footprints")
    else:
        print(f">> SQLite Database:     {DB_PATH} (tables: simulation_footprints, dummy_footprints)")
        print(f">> MongoDB Compass URI: {MONGODB_URI} (Set MONGODB_URI in .env or start mongod)")
    print(f">> Serving Dashboard at: http://localhost:{PORT}")
    print("=" * 64)

    try:
        import flask
        print(">> Web Engine: Flask Active")
        run_flask()
    except ImportError:
        print(">> Web Engine: Built-in Python HTTP Engine (Flask not in this environment)")
        run_builtin()
