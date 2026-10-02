import os
import sys

# Ensure repository root is in sys.path so server can be imported
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import create_app

flask_app = create_app()

def app(environ, start_response):
    """
    WSGI entry point for Vercel Serverless Functions.
    Ensures internal rewrites correctly preserve the original API path
    (e.g. /api/geofences, /api/devices, /api/telemetry) even when Vercel routes
    requests using the rewritten destination path /api/index.py.
    """
    path_info = environ.get('PATH_INFO', '')
    
    # If Vercel sets destination path to /api/index.py or /api/index:
    if path_info in ('/api/index.py', '/api/index', '/api/'):
        # Recover real route from Vercel's matched path or raw URI
        original = environ.get('HTTP_X_MATCHED_PATH') or environ.get('RAW_URI') or environ.get('REQUEST_URI')
        if original:
            clean_original = original.split('?')[0]
            if clean_original.startswith('/api/'):
                environ['PATH_INFO'] = clean_original

    return flask_app(environ, start_response)
