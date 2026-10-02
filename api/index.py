import os
import sys
import urllib.parse

# Ensure repository root is in sys.path so server can be imported
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import create_app

flask_app = create_app()

def app(environ, start_response):
    """
    WSGI entry point for Vercel Serverless Functions.
    Handles internal rewrites, recovers original route paths, and supports CORS preflights.
    """
    # 1. Quick handle for CORS OPTIONS preflights
    if environ.get('REQUEST_METHOD') == 'OPTIONS':
        start_response('200 OK', [
            ('Access-Control-Allow-Origin', '*'),
            ('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'),
            ('Access-Control-Allow-Headers', 'Content-Type, Authorization'),
            ('Content-Length', '0')
        ])
        return [b'']

    # 2. Recover path from __route__ query parameter if injected by vercel.json
    query_string = environ.get('QUERY_STRING', '')
    target_path = None
    if '__route__=' in query_string:
        qs_dict = urllib.parse.parse_qs(query_string, keep_blank_values=True)
        if '__route__' in qs_dict and qs_dict['__route__']:
            target_path = qs_dict['__route__'][0]
            del qs_dict['__route__']
            environ['QUERY_STRING'] = urllib.parse.urlencode(qs_dict, doseq=True)

    # 3. If not found in query string, inspect Vercel proxy headers
    if not target_path:
        for header_key in (
            'HTTP_X_MATCHED_PATH',
            'HTTP_X_VERCEL_MATCHED_PATH',
            'HTTP_X_FORWARDED_URI',
            'HTTP_X_ORIGINAL_URI',
            'RAW_URI',
            'REQUEST_URI',
            'HTTP_X_REWRITE_URL'
        ):
            val = environ.get(header_key)
            if val:
                clean = val.split('?')[0].strip()
                if clean and clean not in ('/api/index.py', '/api/index', '/index.py', '/api/', '/api'):
                    target_path = clean
                    break

    # 4. Apply target path or normalize existing PATH_INFO
    if target_path:
        clean_path = target_path.split('?')[0]
        if not clean_path.startswith('/'):
            clean_path = '/' + clean_path
        if clean_path in ('/api/index.py', '/api/index', '/index.py', '/api/'):
            clean_path = '/api'
        environ['PATH_INFO'] = clean_path
    else:
        curr_path = environ.get('PATH_INFO', '')
        if curr_path in ('/api/index.py', '/api/index', '/index.py', '/api/', '/api', ''):
            environ['PATH_INFO'] = '/api'
        else:
            environ['PATH_INFO'] = curr_path if curr_path.startswith('/') else '/' + curr_path

    environ['SCRIPT_NAME'] = ''
    return flask_app(environ, start_response)

