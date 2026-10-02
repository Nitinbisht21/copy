"""
Database Service for Virtual Fence Tracking System
Manages connection and collections in MongoDB:
  - users
  - devices
  - locations (GeoJSON Point with 2dsphere index)
  - geofence_events
  - device_geofence_state (persistent boundary state)
"""

import os
import pymongo
from datetime import datetime

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb+srv://nitinbisht2030_db_user:l31tSFIKQCYDa2H1@cluster0.tel123h.mongodb.net/?retryWrites=true&w=majority')
MONGODB_TRACKING_DB = os.environ.get('MONGODB_TRACKING_DB', 'tracking_data_db')

# In-memory stores as robust local fallback if MongoDB is unreachable
in_memory_users = {}
in_memory_devices = {}
in_memory_locations = []
in_memory_geofence_events = []
in_memory_device_geofence_state = {}

mongo_client = None
tracking_db = None
use_mongodb = False

def init_tracking_db(client=None):
    """Initializes collections and indexes on the tracking database."""
    global mongo_client, tracking_db, use_mongodb

    if client is not None:
        mongo_client = client
    elif mongo_client is None:
        try:
            timeout_ms = 12000 if 'mongodb+srv' in MONGODB_URI else 3000
            mongo_client = pymongo.MongoClient(MONGODB_URI, serverSelectionTimeoutMS=timeout_ms)
            mongo_client.admin.command('ping')
        except Exception as e:
            use_mongodb = False
            return False

    try:
        tracking_db = mongo_client[MONGODB_TRACKING_DB]
        use_mongodb = True

        # Indexes for fast querying and GeoJSON geospatial operations
        tracking_db.users.create_index('user_id', unique=True)
        tracking_db.users.create_index('email', unique=True)

        tracking_db.devices.create_index('device_id', unique=True)
        tracking_db.devices.create_index('user_id')
        tracking_db.devices.create_index('status')

        # 2dsphere index on location field for true GeoJSON geospatial queries
        tracking_db.locations.create_index([('location', pymongo.GEOSPHERE)])
        tracking_db.locations.create_index('device_id')
        tracking_db.locations.create_index([('timestamp', pymongo.DESCENDING)])

        tracking_db.geofence_events.create_index('event_id', unique=True)
        tracking_db.geofence_events.create_index('device_id')
        tracking_db.geofence_events.create_index('geofence_id')
        tracking_db.geofence_events.create_index([('timestamp', pymongo.DESCENDING)])

        tracking_db.device_geofence_state.create_index(
            [('device_id', pymongo.ASCENDING), ('geofence_id', pymongo.ASCENDING)],
            unique=True
        )

        return True
    except Exception as e:
        print(f">> [Tracking DB Warning] Index initialization note: {e}")
        return True

def get_tracking_db():
    global tracking_db
    if tracking_db is None:
        init_tracking_db()
    return tracking_db
