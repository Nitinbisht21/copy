import os
import sys

# Ensure repository root is in sys.path so server can be imported
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import create_app

# WSGI application callable for Vercel Serverless Functions
app = create_app()
