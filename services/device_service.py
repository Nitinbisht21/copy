"""
Device Management Service
Handles multi-device registration, auto-increment numbering ("Device 1", "Device 2"...),
reconnect recognition (re-assigns previous name & ID to returning phones),
status derivation (ONLINE/INACTIVE/OFFLINE based on last_seen),
and single-location deduplication so one physical phone never creates multiple ghost copies.
"""

import os
import re
import uuid
import math
import time
from datetime import datetime, timedelta, timezone

from services.db import get_tracking_db, in_memory_devices, in_memory_locations, use_mongodb

GENERIC_NAMES = {'mobile device', 'mobile phone', 'device', 'phone', 'anonymous', 'anon'}

# Mobile devices send heartbeats/telemetry every 5s.
# 15-second watchdog timeout allows rapid detection when webpage is killed or closed from device.
ONLINE_HEARTBEAT_TIMEOUT_SECONDS = 15

def parse_iso_timestamp(ts) -> datetime:
    """Safely parses ISO timestamp into UTC-aware datetime."""
    if not ts:
        return None
    try:
        s = str(ts).strip()
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        if '+' not in s and '-' not in s[10:]:
            s += '+00:00'
        return datetime.fromisoformat(s)
    except Exception:
        for fmt in ('%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S'):
            try:
                dt = datetime.strptime(str(ts).strip().rstrip('Z'), fmt)
                return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
            except Exception:
                continue
    return None

def compute_device_status(device: dict) -> str:
    """
    Computes device status strictly without intermediate 'inactive' thresholds.
    Only two states exist:
      - 'online': webpage open on device (foreground, hidden, or switched) with active heartbeats/tracking (last_seen <= 15s)
      - 'offline': killed/closed from device (unload beacon or last_seen > 15s)
    """
    if not device:
        return 'offline'

    if device.get('revoked'):
        return 'revoked'

    # If status is explicitly set to offline or forced offline (e.g. from page close beacon)
    if device.get('is_offline_forced'):
        return 'offline'

    curr_status = (device.get('status') or '').lower().strip()
    if curr_status == 'offline':
        return 'offline'

    last_seen_str = device.get('last_seen')
    if not last_seen_str:
        return 'offline'

    last_dt = parse_iso_timestamp(last_seen_str)
    if not last_dt:
        return 'offline'

    now_utc = datetime.now(timezone.utc)
    diff_sec = (now_utc - last_dt).total_seconds()

    if diff_sec > ONLINE_HEARTBEAT_TIMEOUT_SECONDS:
        return 'offline'

    return 'online'

def _is_generic_name(name: str) -> bool:
    """Checks if a name is a generic placeholder or default auto-name."""
    if not name:
        return True
    s = name.strip().lower()
    if s in GENERIC_NAMES:
        return True
    # If it's just "Device N" or "Phone N" or a bare digit like "1", "2"
    if re.match(r'^(device|phone)?\s*\d+$', s):
        return True
    return False

def _extract_number(val) -> int:
    """Extracts integer device number from integer or string."""
    if isinstance(val, int):
        return val
    if not val:
        return 0
    m = re.search(r'\b(\d+)\b', str(val))
    return int(m.group(1)) if m else 0

def get_next_device_number() -> int:
    """
    Auto-increment function:
    Determines next device number (1, 2, 3...) based on all registered devices.
    """
    seen_numbers = set()
    all_devs = list(in_memory_devices.values())

    db = get_tracking_db()
    if db is not None:
        try:
            docs = list(db.devices.find({'revoked': {'$ne': True}}, {'_id': 0, 'device_number': 1, 'device_name': 1, 'device_id': 1}))
            all_devs.extend(docs)
        except Exception:
            pass

    for d in all_devs:
        if d.get('revoked'):
            continue
        num = d.get('device_number')
        if num and isinstance(num, int):
            seen_numbers.add(num)
        name_num = _extract_number(d.get('device_name'))
        if name_num > 0:
            seen_numbers.add(name_num)
        id_num = _extract_number(d.get('device_id'))
        if id_num > 0:
            seen_numbers.add(id_num)

    if not seen_numbers:
        return 1
    return max(seen_numbers) + 1

def find_existing_device(custom_id: str = None, client_uuid: str = None, fingerprint: str = None) -> dict:
    """
    Finds an existing registered device for reconnect memory.
    Matches strictly on:
      1. Exact custom_id / device_id match
      2. Exact client_uuid match (unique persistent installation ID per client)
    Does NOT match on IP or platform, ensuring multiple distinct phones on the same
    WiFi or with identical OS NEVER hijack each other.
    """
    all_devices = dict(in_memory_devices)
    db = get_tracking_db()
    if db is not None:
        try:
            for doc in db.devices.find({}, {'_id': 0}):
                all_devices[doc['device_id']] = doc
        except Exception:
            pass

    # 1. Exact ID match
    if custom_id:
        c_id = custom_id.strip()
        if c_id in all_devices:
            return all_devices[c_id]
        for dev in all_devices.values():
            if dev.get('device_id') == c_id:
                return dev

    # 2. Exact client_uuid match
    if client_uuid:
        cu = client_uuid.strip()
        if len(cu) >= 6:
            for dev in all_devices.values():
                if dev.get('client_uuid') == cu:
                    return dev

    return None

def register_device(
    device_name: str = None,
    user_id: str = 'anon_user',
    platform: str = 'browser',
    custom_id: str = None,
    client_uuid: str = None,
    fingerprint: str = None,
    client_ip: str = None
) -> tuple:
    """
    Registers a tracking device or reconnects an existing physical phone.
    - If phone has connected previously (matched by client_uuid or custom_id): Reconnects, preserves previous name & ID.
    - If brand new phone (distinct client_uuid): Applies auto-increment function (Device 1, Device 2...), assigns unique ID.
    """
    uid = (user_id or 'anon_user').strip()
    plat = (platform or 'browser').lower().strip()
    now = datetime.utcnow().isoformat() + 'Z'
    incoming_name = (device_name or '').strip()
    cu = (client_uuid or '').strip() or None

    # Check if this physical phone already exists (Reconnect!)
    existing = find_existing_device(custom_id=custom_id, client_uuid=cu, fingerprint=fingerprint)

    if existing:
        # RECONNECT: Keep previous name and previous ID as requested by user!
        device_id = existing['device_id']
        prev_name = existing.get('device_name')

        # If incoming name is generic, always preserve previous name
        if _is_generic_name(incoming_name) or not incoming_name:
            final_name = prev_name or f"Device {existing.get('device_number', 1)}"
        else:
            # User explicitly typed a custom name in modal
            final_name = incoming_name

        existing['device_name'] = final_name
        existing['last_seen'] = now
        existing['updated_at'] = now
        existing['platform'] = plat
        existing['revoked'] = False
        existing['is_offline_forced'] = False
        existing['is_tab_active'] = True
        if cu:
            existing['client_uuid'] = cu
        if fingerprint:
            existing['fingerprint'] = fingerprint
        if client_ip:
            existing['client_ip'] = client_ip

        in_memory_devices[device_id] = existing

        db = get_tracking_db()
        if db is not None:
            try:
                doc = dict(existing)
                db.devices.replace_one({'device_id': device_id}, doc, upsert=True)
            except Exception as e:
                print(f">> [MongoDB Device Reconnect Error] {e}")

        result = dict(existing)
        result['status'] = compute_device_status(result)
        result['reconnected'] = True
        return result, None

    # BRAND NEW PHONE: Apply Increment Function ("Device 1", "Device 2"...)
    next_num = get_next_device_number()

    if not incoming_name or _is_generic_name(incoming_name):
        name = f"Device {next_num}"
    else:
        name = incoming_name

    device_id = (custom_id or f"DEV_{next_num:02d}_{uuid.uuid4().hex[:4].upper()}").strip()

    device_doc = {
        'device_id': device_id,
        'device_number': next_num,
        'user_id': uid,
        'device_name': name,
        'platform': plat,
        'client_uuid': cu,
        'fingerprint': fingerprint,
        'client_ip': client_ip,
        'status': 'online',
        'is_tab_active': True,
        'tracking_active': False,
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
    result['reconnected'] = False
    return result, None

def get_device(device_id: str) -> dict:
    """Retrieves device by ID with dynamically computed status."""
    if not device_id:
        return None

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
        computed_status = compute_device_status(dev_copy)
        dev_copy['status'] = computed_status
        dev_copy['tracking_active'] = (computed_status == 'online')
        return dev_copy
    return None

def deduplicate_devices_list(device_list: list) -> list:
    """
    Deduplicates device records so that one physical phone has ONLY ONE record.
    Merges duplicate copies of the same client (matching client_uuid or device_id).
    NEVER purges distinct physical devices just because they are nearby or share an IP.
    """
    if not device_list:
        return []

    unique_map = {}
    stale_ids_to_purge = set()

    for dev in device_list:
        did = dev.get('device_id')
        cu = dev.get('client_uuid')

        # Primary grouping key is client_uuid if present, else device_id
        if cu and len(str(cu).strip()) >= 6:
            key = f"cu_{str(cu).strip()}"
        else:
            key = f"id_{did}"

        if key not in unique_map:
            unique_map[key] = dev
        else:
            existing = unique_map[key]
            existing_ts = existing.get('last_seen') or existing.get('updated_at') or ''
            current_ts = dev.get('last_seen') or dev.get('updated_at') or ''

            if current_ts >= existing_ts:
                # Current is newer; mark existing as stale if different ID
                if existing.get('device_id') != did:
                    stale_ids_to_purge.add(existing.get('device_id'))
                if _is_generic_name(dev.get('device_name')) and not _is_generic_name(existing.get('device_name')):
                    dev['device_name'] = existing['device_name']
                unique_map[key] = dev
            else:
                # Existing is newer; mark current as stale if different ID
                if did != existing.get('device_id'):
                    stale_ids_to_purge.add(did)

    # Clean up purged stale IDs from in-memory cache and DB
    if stale_ids_to_purge:
        for sid in stale_ids_to_purge:
            in_memory_devices.pop(sid, None)
        db = get_tracking_db()
        if db is not None:
            try:
                db.devices.delete_many({'device_id': {'$in': list(stale_ids_to_purge)}})
            except Exception:
                pass

    return list(unique_map.values())

def list_devices(user_id: str = None, include_revoked: bool = False) -> list:
    """Lists unique devices with status. Guarantees 1 physical device = 1 entry."""
    raw_devices = []
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
                raw_devices.append(d)
        except Exception as e:
            print(f">> [MongoDB Device List Error] {e}")

    if not raw_devices:
        for d in in_memory_devices.values():
            if user_id and d.get('user_id') != user_id:
                continue
            if not include_revoked and d.get('revoked'):
                continue
            raw_devices.append(d)

    # Deduplicate so only 1 copy per physical phone is returned
    deduped = deduplicate_devices_list(raw_devices)

    final_devices = []
    for d in deduped:
        d_copy = dict(d)
        computed_status = compute_device_status(d_copy)
        if d.get('status') != computed_status:
            d['status'] = computed_status
            did = d.get('device_id')
            if did and did in in_memory_devices:
                in_memory_devices[did]['status'] = computed_status
            if db is not None:
                try:
                    db.devices.update_one(
                        {'device_id': did},
                        {'$set': {'status': computed_status}}
                    )
                except Exception:
                    pass
        d_copy['status'] = computed_status
        final_devices.append(d_copy)

    final_devices.sort(key=lambda x: x.get('last_seen', ''), reverse=True)
    return final_devices

def update_device(device_id: str, updates: dict) -> dict:
    """Updates device details."""
    existing = get_device(device_id)
    if not existing:
        return None

    allowed_keys = [
        'device_name', 'platform', 'revoked', 'last_seen', 'last_location',
        'current_fence', 'status', 'is_offline_forced', 'offline_reason',
        'distance_outside', 'tracking_active', 'fingerprint', 'client_ip',
        'device_number', 'client_uuid', 'outside_fence', 'flagged', 'flag',
        'is_tab_active'
    ]
    for k in allowed_keys:
        if k in updates:
            existing[k] = updates[k]

    now = datetime.utcnow().isoformat() + 'Z'
    existing['updated_at'] = now
    if existing.get('is_offline_forced') or updates.get('status') == 'offline':
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

def ping_device(
    device_id: str,
    client_ip: str = None,
    status: str = 'online',
    tracking_active: bool = None,
    is_tab_active: bool = True,
    client_uuid: str = None
) -> dict:
    """
    Heartbeat / state update from mobile device or web panel.
    - When webpage is alive on device (foreground, background, hidden, or switched): stays ONLINE.
    - Only marks OFFLINE when page is killed/closed or when status is explicitly 'offline'.
    """
    dev = get_device(device_id)
    if not dev and client_uuid:
        dev = find_existing_device(client_uuid=client_uuid)
        if dev:
            device_id = dev['device_id']

    if not dev or dev.get('revoked'):
        return None

    now = datetime.utcnow().isoformat() + 'Z'
    updates = {'last_seen': now}
    if client_ip:
        updates['client_ip'] = client_ip

    if tracking_active is not None:
        updates['tracking_active'] = bool(tracking_active)

    if status == 'offline':
        updates['status'] = 'offline'
        updates['is_offline_forced'] = True
        updates['is_tab_active'] = False
    else:
        # Webpage is running on device (foreground, hidden, or switched tab): ONLINE
        updates['status'] = 'online'
        updates['is_offline_forced'] = False
        updates['is_tab_active'] = True

    return update_device(device_id, updates)

def purge_all_duplicates() -> int:
    """Purges all duplicate device copies across the database."""
    devices = list_devices(include_revoked=False)
    return len(devices)

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
