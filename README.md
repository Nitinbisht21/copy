# Virtual Fence - Interactive Geofence Map Builder

A modern, high-performance geofence management system and map builder with an interactive web dashboard and a lightweight Python backend powered exclusively by MongoDB.

🌐 **Live Application:** [Geofence Map Builder | Real-Time Geographic Boundary Creator](https://virtual-fence.vercel.app/)

> 📖 **Looking for the complete operational guide?** Check out the [Comprehensive User Manual](USER_MANUAL.md) for step-by-step instructions, kinematics modeling, simulation walkthroughs, and MongoDB inspection guides.

---

## Live Deployment (Vercel)

The live production application is accessible at:
🔗 **[Geofence Map Builder | Real-Time Geographic Boundary Creator](https://virtual-fence.vercel.app/)**

For step-by-step instructions on setting up Atlas IP access and deploying your own instance, see [User Manual - Section 11: Deploying to Vercel](USER_MANUAL.md#11-deploying-to-vercel-1-click-guide).

---

## Features

- **3 Geometric Geofence Types**:
  - **Circle**: Precise center coordinates (`lat`/`lng`) with real-time radius slider and quick presets (50m, 100m, 200m, 500m, 1 km, 2 km).
  - **Rectangle**: North/South Lat & East/West Lng bounding box with interactive corner handles.
  - **Custom Polygon**: Multi-point custom polygon drawing with real-time vertex tracking, perimeter, and area calculation.
- **Dual Workflow Modes**:
  - **+ Add Geofence Mode**: On-demand drawing canvas to create or update geofences without accidental edits.
  - **Explore Mode**: Freely navigate, pan, zoom, inspect, and select existing fences on the map.
- **Multiple Base Map Layers**:
  - OpenStreetMap Standard
  - Esri World Street Map
  - OpenStreetMap Humanitarian
  - Esri World Satellite
  - OpenTopoMap
- **Spatial Calculations**:
  - Point-in-Polygon (Ray-Casting Algorithm)
  - Great-Circle Haversine distance for circular boundaries
  - Bounding box containment tests
  - Real-time geodesic perimeter and surface area metrics
- **Real-Time GPS Multi-Device Ingestion**:
  - Ingests real GPS telemetry from mobile phones and external tracking units via `POST /api/telemetry`.
  - Fires persistent **`ENTER`** and **`EXIT`** boundary breach events only on genuine state changes.
  - Live breadcrumb trails and historical path visualization for any selected device.
- **Dedicated Mobile Phone Tracker**:
  - Web client (`/track` or `track.html`) with HTML5 Geolocation `watchPosition()` and Screen Wake Lock API.
- **Persistent Storage (Pure MongoDB)**:
  - Exclusively powered by MongoDB Atlas & MongoDB Compass across two databases: `simulation_data_db` (geofences) and `tracking_data_db` (users, devices, locations with 2dsphere indexing, geofence_events).

---

## Project Structure

```
virtualfence/
├── api/
│   └── index.py             # Vercel Serverless WSGI entrypoint
├── css/
│   └── style.css            # Custom CSS styling (dark/light UI, responsive layout)
├── js/
│   └── bundle.js            # Frontend map engine, drawing handlers, and simulation loop
├── vendor/
│   ├── leaflet.css          # Leaflet CSS library
│   └── leaflet.js           # Leaflet JavaScript library
├── index.html               # Main dashboard UI
├── server.py                # Python backend (REST API, Telemetry Engine, MongoDB Atlas)
├── vercel.json              # Vercel serverless routing configuration
├── .vercelignore            # Vercel deployment exclusions (venv, .env, cache)
├── requirements.txt         # Python dependencies (Flask, pymongo, python-dotenv, dnspython)
├── .env.example             # MongoDB URI configuration template
├── .gitignore               # Git ignore rules for venv, cache, and env
├── USER_MANUAL.md           # Comprehensive User Manual and operational guide
└── README.md                # Project overview and quick start documentation
```

---

## Getting Started

### Prerequisites

- **Python 3.8+** installed on your system.
- Modern web browser (Chrome, Firefox, Edge, Safari).
- Free MongoDB Atlas cluster or local MongoDB instance.

### 1. Clone the Repository

```bash
git clone https://github.com/Nitinbisht21/virtual_fence.git
cd virtual_fence
```

### 2. Set Up Virtual Environment & Dependencies

```bash
# Create virtual environment
python -m venv venv

# Activate on Windows:
.\venv\Scripts\activate

# Activate on macOS/Linux:
source venv/bin/activate

# Install dependencies (pymongo, flask, python-dotenv, dnspython)
pip install -r requirements.txt
```

### 3. Configure MongoDB Atlas Connection

Create a `.env` file in the project root (or edit existing):
```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>.mongodb.net/?retryWrites=true&w=majority
MONGODB_SIMULATION_DB=simulation_data_db
MONGODB_TRACKING_DB=tracking_data_db
PORT=5000
```

### 4. Start the Server

```bash
python server.py
```

The server will launch at:
```
http://localhost:5000
```

- **Admin Geofence Dashboard**: `http://localhost:5000` (or `http://localhost:5000/admin`)
- **Mobile Phone GPS Tracker**: `http://localhost:5000/track` (or `http://localhost:5000/user`)

---

## MongoDB Architecture & Live Database Models

The application connects to your MongoDB cluster via the URI specified in your private `.env` file:
```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>.mongodb.net/?retryWrites=true&w=majority
```

### Live Cluster Overview

| Database | Collection | Data Classification | Contents & Description |
|---|---|---|---|
| **`simulation_data_db`** | `geofences` | Persistent Config | Active perimeter shapes (`circle`, `rectangle`, `polygon`), coordinates, radii, and status. |
| **`simulation_data_db`** | `simulation_footprints` | Real-time Stream | Live geofence breach events mirroring real GPS transitions (`ENTER`, `EXIT`). |
| **`tracking_data_db`** | `devices` | Device Registry | Multi-device registry tracking status (`online`, `inactive`, `offline`), platform, user assignment, and last seen. |
| **`tracking_data_db`** | `locations` | Spatial GeoJSON | Real GPS coordinate history indexed with `2dsphere` Point `[longitude, latitude]`. |
| **`tracking_data_db`** | `geofence_events` | Boundary Breaches | Persistent `ENTER` and `EXIT` logs fired on actual perimeter state transitions. |
| **`tracking_data_db`** | `device_geofence_state`| State Engine | Tracks whether each device is currently inside or outside each active geofence. |

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/database/status` | Check active database & MongoDB connection info |
| `GET` | `/api/geofences` | Retrieve all geofences |
| `POST` | `/api/geofences` | Create a new geofence |
| `GET` | `/api/geofences/<id>` | Get details of a single geofence |
| `PUT` | `/api/geofences/<id>` | Update an existing geofence |
| `DELETE` | `/api/geofences/<id>` | Delete a geofence |
| `GET` | `/api/devices` | List registered tracking devices |
| `POST` | `/api/devices/register` | Register a new device |
| `GET` | `/api/devices/<id>/history` | Retrieve historical GPS trail for a device |
| `POST` | `/api/telemetry` | Ingest real mobile GPS telemetry and evaluate geofences |
| `GET` | `/api/events` | Retrieve real geofence breach transition events |
| `GET` | `/api/footprints` | Retrieve recent footprints |
| `DELETE` | `/api/footprints` | Clear footprint collections in MongoDB |

### Telemetry Evaluation Request Example

```json
POST /api/telemetry/evaluate
Content-Type: application/json

{
  "device_id": "truck_unit_104",
  "lat": 30.123456,
  "lng": 78.123456
}
```

**Response:**
```json
{
  "device_id": "truck_unit_104",
  "lat": 30.123456,
  "lng": 78.123456,
  "active_inside": [
    {
      "id": "geo_default_headquarters",
      "name": "Headquarters Perimeter",
      "type": "circle"
    }
  ],
  "event": "inside"
}
```

---

## License

This project is open source and available under the [MIT License](LICENSE).
