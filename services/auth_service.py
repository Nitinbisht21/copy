"""
Authentication & Authorization Service
Handles user registration, password hashing (PBKDF2-HMAC-SHA256), token issuance,
role validation (Admin vs User), and default admin account seeding.
"""

import os
import hmac
import hashlib
import base64
import json
import uuid
import time
from functools import wraps
from datetime import datetime

from services.db import get_tracking_db, in_memory_users, use_mongodb

SECRET_KEY = os.environ.get('SECRET_KEY', 'virtualfence_jwt_super_secret_2026')
TOKEN_EXPIRY_SECONDS = 7 * 24 * 3600  # 7 days

def hash_password(password: str, salt: str = None) -> tuple:
    """Hashes password using PBKDF2-HMAC-SHA256 with 100,000 iterations."""
    if not salt:
        salt = uuid.uuid4().hex
    pwd_bytes = password.encode('utf-8')
    salt_bytes = salt.encode('utf-8')
    hash_bytes = hashlib.pbkdf2_hmac('sha256', pwd_bytes, salt_bytes, 100000)
    return salt, hash_bytes.hex()

def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    """Verifies candidate password against stored salt and hash."""
    _, candidate_hash = hash_password(password, salt)
    return hmac.compare_digest(candidate_hash, expected_hash)

def generate_token(user: dict) -> str:
    """Generates a tamper-proof signed token containing user_id, email, and role."""
    payload = {
        'user_id': user['user_id'],
        'email': user['email'],
        'role': user.get('role', 'user'),
        'name': user.get('name', 'User'),
        'exp': int(time.time()) + TOKEN_EXPIRY_SECONDS
    }
    payload_json = json.dumps(payload, separators=(',', ':'))
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode('utf-8')).decode('utf-8').rstrip('=')
    signature = hmac.new(SECRET_KEY.encode('utf-8'), payload_b64.encode('utf-8'), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"

def verify_token(token: str) -> dict:
    """Verifies signature and expiration of a signed token."""
    if not token or '.' not in token:
        return None
    try:
        payload_b64, signature = token.split('.', 1)
        expected_sig = hmac.new(SECRET_KEY.encode('utf-8'), payload_b64.encode('utf-8'), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected_sig):
            return None

        # Add padding back if necessary
        padded_b64 = payload_b64 + '=' * (-len(payload_b64) % 4)
        payload_json = base64.urlsafe_b64decode(padded_b64.encode('utf-8')).decode('utf-8')
        payload = json.loads(payload_json)

        if payload.get('exp', 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None

def find_user_by_email(email: str) -> dict:
    """Finds user by email in MongoDB or in-memory fallback."""
    clean_email = (email or '').strip().lower()
    db = get_tracking_db()
    if db is not None:
        try:
            doc = db.users.find_one({'email': clean_email}, {'_id': 0})
            if doc:
                return doc
        except Exception:
            pass
    for u in in_memory_users.values():
        if u['email'].lower() == clean_email:
            return dict(u)
    return None

def find_user_by_id(user_id: str) -> dict:
    """Finds user by user_id in MongoDB or in-memory fallback."""
    db = get_tracking_db()
    if db is not None:
        try:
            doc = db.users.find_one({'user_id': user_id}, {'_id': 0})
            if doc:
                return doc
        except Exception:
            pass
    return in_memory_users.get(user_id)

def register_user(name: str, email: str, password: str, role: str = 'user') -> tuple:
    """Registers a new user. Returns (user_dict, None) on success or (None, error_msg)."""
    clean_email = (email or '').strip().lower()
    clean_name = (name or '').strip()
    if not clean_email or '@' not in clean_email:
        return None, "Invalid email address."
    if not clean_name:
        return None, "Name is required."
    if not password or len(password) < 6:
        return None, "Password must be at least 6 characters."

    existing = find_user_by_email(clean_email)
    if existing:
        return None, "User with this email already exists."

    user_id = f"usr_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    salt, pwd_hash = hash_password(password)
    now = datetime.utcnow().isoformat() + 'Z'

    user_doc = {
        'user_id': user_id,
        'name': clean_name,
        'email': clean_email,
        'password_hash': pwd_hash,
        'salt': salt,
        'role': role if role in ('admin', 'user') else 'user',
        'created_at': now
    }

    in_memory_users[user_id] = user_doc

    db = get_tracking_db()
    if db is not None:
        try:
            doc = dict(user_doc)
            db.users.replace_one({'user_id': user_id}, doc, upsert=True)
        except Exception as e:
            print(f">> [MongoDB User Write Error] {e}")

    safe_user = dict(user_doc)
    safe_user.pop('password_hash', None)
    safe_user.pop('salt', None)
    return safe_user, None

def login_user(email: str, password: str) -> tuple:
    """Authenticates user credentials and returns (safe_user, token) or (None, error_msg)."""
    user = find_user_by_email(email)
    if not user:
        return None, "Invalid email or password."

    if not verify_password(password, user['salt'], user['password_hash']):
        return None, "Invalid email or password."

    safe_user = dict(user)
    safe_user.pop('password_hash', None)
    safe_user.pop('salt', None)
    safe_user.pop('_id', None)

    token = generate_token(safe_user)
    return (safe_user, token), None

def seed_default_admin():
    """Seeds default admin account if not already present."""
    admin_email = os.environ.get('ADMIN_DEFAULT_EMAIL', 'admin@virtualfence.io').strip().lower()
    admin_pass = os.environ.get('ADMIN_DEFAULT_PASSWORD', 'admin123')
    existing = find_user_by_email(admin_email)
    if not existing:
        register_user(
            name="System Administrator",
            email=admin_email,
            password=admin_pass,
            role="admin"
        )
        print(f">> [Auth] Seeded default Admin user: {admin_email}")

def extract_token_from_request(req) -> str:
    """Extracts bearer token from Authorization header or 'token' query param."""
    auth_header = req.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    return req.args.get('token', '')

def get_current_user(req) -> dict:
    """Returns authenticated user payload from request or None."""
    token = extract_token_from_request(req)
    if not token:
        return None
    return verify_token(token)
