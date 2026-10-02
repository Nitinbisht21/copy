"""
Device Management Service
Handles multi-device registration, status derivation (ONLINE/INACTIVE/OFFLINE based on last_seen),
device revocation, and location history queries.
"""

import os
import uuid
import time
from datetime import datetime, timedelta

from services.db import get_tracking_db, in_memory_devices, in_memory_locations, use_mongodb

ONLINE_THRESHOLD_SECONDS = int(os.environ.get('DEVICE_ONLINE_THRESHOLD_SEC', 180)) # 3 minutes, supports 2-min database reporting interval
INACTIVE_THRESHOLD_SECONDS = int(os.environ.get('DEVICE_INACTIVE_THRESHOLD_SEC', 360)) # 6 minutes

def compute_device_status(device: dict) -> str:
    """Computes dynamic status: online, inactive, or offline based on last_seen and geofence state."""
    if device.get('revoked'):
        return 'revoked'

    # If device was marked offline because it moved >100m outside the active geofence
    if device.get('is_offline_forced') or device.get('offline_reason') == 'outside_fence_100m':
        return 'offline'

    last_seen_str = device.get('last_seen')
    if not last_seen_str:
        return 'offline'

    try:
        # Strip trailing Z and parse UTC
        clean_ts = last_seen_str.rstrip('Z')
        last_dt = datetime.fromisoformat(clean_ts)
        diff_sec = (datetime.utcnow() - last_dt).total_seconds()

        if diff_sec <= ONLINE_THRESHOLD_SECONDS:
            return 'online'
        elif diff_sec <= INACTIVE_THRESHOLD_SECONDS:
            return 'inactive'
        else:
            return 'offline'
    except Exception:
        return 'offline'

def register_device(device_name: str, user_id: str, platform: str = 'browser', custom_id: str = None) -> tuple:
    """Registers a new tracking device under a user."""
    name = (device_name or 'Mobile Device').strip()
    uid = (user_id or 'anonymous').strip()
    plat = (platform or 'browser').lower().strip()

    device_id = (custom_id or f"DEV_{uuid.uuid4().hex[:6].upper()}").strip()
    now = datetime.utcnow().isoformat() + 'Z'

    device_doc = {
        'device_id': device_id,
        'user_id': uid,
        'device_name': name,
        'platform': plat,
        'status': 'offline',
        'is_offline_forced': False,
        'offline_reason': None,
        'distance_outside': 0.0,
        'last_seen': now,
        'last_location': None,
        'current_fence': None,
        'revoked': False,
        'created_at': now,
        'updated_at': now
    }

    in_memory_devices[device_id] = device_doc

    db = get_tracking_db()
    if db is not None:
        try:
            doc = dict(device_doc)
            db.devices.replace_one({'device_id': device_id}, doc, upsert=True)
        except Exception as e:
            print(f">> [MongoDB Device Write Error] {e}")

    result = dict(device_doc)
    result['status'] = compute_device_status(result)
    return result, None

def get_device(device_id: str) -> dict:
    """Retrieves device by ID with dynamically computed status."""
    db = get_tracking_db()
    dev = None
    if db is not None:
        try:
            doc = db.devices.find_one({'device_id': device_id}, {'_id': 0})
            if doc:
                dev = doc
        except Exception:
            pass

    if not dev:
        dev = in_memory_devices.get(device_id)

    if dev:
        dev_copy = dict(dev)
        dev_copy['status'] = compute_device_status(dev_copy)
        return dev_copy
    return None

def list_devices(user_id: str = None, include_revoked: bool = False) -> list:
    """Lists devices, optionally filtering by user_id. Updates status on the fly."""
    devices = []
    db = get_tracking_db()

    if db is not None:
        try:
            query = {}
            if user_id:
                query['user_id'] = user_id
            if not include_revoked:
                query['revoked'] = {'$ne': True}

            docs = list(db.devices.find(query, {'_id': 0}).sort('last_seen', -1))
            for d in docs:
                in_memory_devices[d['device_id']] = d
                d_copy = dict(d)
                d_copy['status'] = compute_device_status(d_copy)
                devices.append(d_copy)
            return devices
        except Exception as e:
            print(f">> [MongoDB Device List Error] {e}")

    for d in in_memory_devices.values():
        if user_id and d.get('user_id') != user_id:
            continue
        if not include_revoked and d.get('revoked'):
            continue
        d_copy = dict(d)
        d_copy['status'] = compute_device_status(d_copy)
        devices.append(d_copy)

    devices.sort(key=lambda x: x.get('last_seen', ''), reverse=True)
    return devices

def update_device(device_id: str, updates: dict) -> dict:
    """Updates device details."""
    existing = get_device(device_id)
    if not existing:
        return None

    allowed_keys = [
        'device_name', 'platform', 'revoked', 'last_seen', 'last_location',
        'current_fence', 'status', 'is_offline_forced', 'offline_reason',
        'distance_outside', 'tracking_active'
    ]
    for k in allowed_keys:
        if k in updates:
            existing[k] = updates[k]

    now = datetime.utcnow().isoformat() + 'Z'
    existing['updated_at'] = now
    if existing.get('is_offline_forced'):
        existing['status'] = 'offline'
    else:
        existing['status'] = compute_device_status(existing)

    in_memory_devices[device_id] = existing

    db = get_tracking_db()
    if db is not None:
        try:
            doc = dict(existing)
            doc.pop('_id', None)
            db.devices.replace_one({'device_id': device_id}, doc)
        except Exception as e:
            print(f">> [MongoDB Device Update Error] {e}")

    return existing

def revoke_device(device_id: str) -> bool:
    """Revokes/disables a device so it cannot send further telemetry."""
    res = update_device(device_id, {'revoked': True})
    return res is not None

def delete_device(device_id: str) -> bool:
    """Permanently deletes a device and its history."""
    in_memory_devices.pop(device_id, None)
    db = get_tracking_db()
    if db is not None:
        try:
            db.devices.delete_one({'device_id': device_id})
            db.locations.delete_many({'device_id': device_id})
            db.geofence_events.delete_many({'device_id': device_id})
            db.device_geofence_state.delete_many({'device_id': device_id})
            return True
        except Exception:
            pass
    return True

def get_device_history(device_id: str, limit: int = 150, from_time: str = None, to_time: str = None) -> list:
    """Retrieves chronological location history trail for a device."""
    limit = max(1, min(int(limit), 500))
    history = []
    db = get_tracking_db()

    if db is not None:
        try:
            query = {'device_id': device_id}
            if from_time or to_time:
                ts_query = {}
                if from_time:
                    ts_query['$gte'] = from_time
                if to_time:
                    ts_query['$lte'] = to_time
                query['timestamp'] = ts_query

            docs = list(db.locations.find(query, {'_id': 0}).sort('timestamp', 1).limit(limit))
            return docs
        except Exception as e:
            print(f">> [MongoDB History Error] {e}")

    for loc in in_memory_locations:
        if loc.get('device_id') == device_id:
            ts = loc.get('timestamp', '')
            if from_time and ts < from_time:
                continue
            if to_time and ts > to_time:
                continue
            history.append(loc)

    history.sort(key=lambda x: x.get('timestamp', ''))
    return history[-limit:]
