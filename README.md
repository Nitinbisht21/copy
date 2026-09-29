# Virtual Fence - Interactive Geofence Map Builder

A modern, high-performance geofence management system and map builder with an interactive web dashboard and a lightweight Python backend powered exclusively by MongoDB.

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
- **3-Second Asset Simulation Engine**:
  - Assets (`Drone Alpha`, `Patrol 101`, `Scout 9`) dynamically transition every 3 seconds through a 4-stage lifecycle:
    - **`ENTER`**: Boundary perimeter entry &rarr; renders green radar flag on map &rarr; records to MongoDB.
    - **`INSIDE`**: Interior waypoints &rarr; plots footprint breadcrumb &rarr; records to MongoDB.
    - **`EXIT`**: Boundary perimeter exit &rarr; renders red radar flag on map &rarr; records to MongoDB.
- **Clean Map Canvas on Startup**:
  - The map loads clean on launch without rendering past historical trails or old flags.
- **Persistent Storage (Pure MongoDB)**:
  - Exclusively powered by MongoDB Atlas & MongoDB Compass across two dedicated databases: `simulation_data_db` and `dummy_data_db`. No SQLite or local disk file logs.
- **Real-Time Telemetry & Mouse Tracking**:
  - Live cursor positions, clicks, and boundary crossing events stream directly to MongoDB under `device_id: MOUSE_POINTER` and `device_id: MOUSE_CLICK`.

---

## Project Structure

```
virtualfence/
├── css/
│   └── style.css            # Custom CSS styling (dark/light UI, responsive layout)
├── js/
│   └── bundle.js            # Frontend map engine, drawing handlers, and simulation loop
├── vendor/
│   ├── leaflet.css          # Leaflet CSS library
│   └── leaflet.js           # Leaflet JavaScript library
├── index.html               # Main dashboard UI
├── server.py                # Python backend (REST API, Telemetry Engine, MongoDB Atlas)
├── requirements.txt         # Python dependencies (Flask, pymongo, python-dotenv, dnspython)
├── .env.example             # MongoDB URI configuration template
├── .gitignore               # Git ignore rules for venv, cache, and env
└── README.md                # Project documentation
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
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.7ulskib.mongodb.net/?retryWrites=true&w=majority
MONGODB_SIMULATION_DB=simulation_data_db
MONGODB_DUMMY_DB=dummy_data_db
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

Open `http://localhost:5000` in your browser to access the Geofence Map Builder dashboard.

---

## MongoDB Architecture & Live Database Models

The application exclusively uses your MongoDB Atlas Cluster:
```
mongodb+srv://Nitin:fence@cluster0.7ulskib.mongodb.net/?retryWrites=true&w=majority
```

### Live Cluster Overview

| Database | Collection | Data Classification | Contents & Description |
|---|---|---|---|
| **`simulation_data_db`** | `geofences` | Persistent Config | Active perimeter shapes (`circle`, `rectangle`, `polygon`), coordinates, radii, and status. |
| **`simulation_data_db`** | `simulation_footprints` | Real-time Stream | Live mouse movements (`MOUSE_POINTER`), map clicks (`MOUSE_CLICK`), and 3-sec simulation loop waypoints. |
| **`dummy_data_db`** | `dummy_footprints` | Test & Simulation | Isolated dummy patrol asset tracking (`ENTER`, `INSIDE`, `EXIT`) generated inside active fences. |

---

### Database Document Schemas & Live Examples

#### 1. `simulation_data_db` &rarr; Collection: `geofences`
Stores geofence definitions created from the web builder:
```json
{
  "id": "geo_demo_alpha",
  "name": "Demo Alpha Perimeter",
  "type": "circle",
  "coordinates": {
    "lat": 30.123456,
    "lng": 78.123456
  },
  "radius": 320.0,
  "status": "active",
  "color": "#2563eb",
  "description": "Auto-generated demo circular perimeter with real-time telemetry",
  "created_at": "2026-09-28T12:00:00.000Z",
  "updated_at": "2026-09-28T17:51:35.471669Z"
}
```

#### 2. `simulation_data_db` &rarr; Collection: `simulation_footprints`
Stores real-time mouse navigation telemetry and fence boundary alerts:
```json
{
  "id": "fp_1790598105054_7ecbb6",
  "device_id": "MOUSE_POINTER",
  "geofence_id": "geo_demo_alpha",
  "geofence_name": "Demo Alpha Perimeter",
  "latitude": 30.1235,
  "longitude": 78.1235,
  "event": "ENTER",
  "color": "#2563eb",
  "source": "mouse_cross_fence",
  "database": "simulation_data_db",
  "collection": "simulation_footprints",
  "created_at": "2026-09-28T17:51:45.054970Z"
}
```

#### 3. `dummy_data_db` &rarr; Collection: `dummy_footprints`
Stores patrol unit movements cycling through `ENTER`, `INSIDE`, and `EXIT` lifecycle states:
```json
[
  {
    "id": "fp_1790598099912_79a1f7",
    "device_id": "FIELD_RANGER_7",
    "geofence_id": "geo_demo_alpha",
    "geofence_name": "Demo Alpha Perimeter",
    "event": "ENTER",
    "latitude": 30.124436,
    "longitude": 78.126510,
    "source": "area_dummy_generator",
    "database": "dummy_data_db",
    "collection": "dummy_footprints",
    "created_at": "2026-09-28T17:51:39.912313Z"
  },
  {
    "id": "fp_1790598099954_d13ab4",
    "device_id": "FIELD_RANGER_7",
    "geofence_id": "geo_demo_alpha",
    "geofence_name": "Demo Alpha Perimeter",
    "event": "INSIDE",
    "latitude": 30.122012,
    "longitude": 78.121891,
    "source": "area_dummy_generator",
    "database": "dummy_data_db",
    "collection": "dummy_footprints",
    "created_at": "2026-09-28T17:51:39.954725Z"
  },
  {
    "id": "fp_1790598099997_528c66",
    "device_id": "FIELD_RANGER_7",
    "geofence_id": "geo_demo_alpha",
    "geofence_name": "Demo Alpha Perimeter",
    "event": "EXIT",
    "latitude": 30.122263,
    "longitude": 78.120360,
    "source": "area_dummy_generator",
    "database": "dummy_data_db",
    "collection": "dummy_footprints",
    "created_at": "2026-09-28T17:51:39.997063Z"
  }
]
```

---

## How Dummy Data Works

1. **Where it is Stored**:
   - In MongoDB under database `dummy_data_db` and collection `dummy_footprints`.
2. **How it is Created**:
   - **Initial Seed**: If `dummy_data_db.dummy_footprints` is empty on startup, the backend automatically seeds initial `ENTER`, `INSIDE`, and `EXIT` dummy points for `Demo Sector B Depot`.
   - **On-Demand Generation**: Sending a `POST /api/simulation/generate` request runs `generate_dummy_movement_sequence()` to generate mathematically valid boundary crossing and interior waypoints inside active geofences.
3. **How to Fetch / Retrieve Dummy Data**:
   - **Via REST API**:
     ```bash
     GET http://localhost:5000/api/footprints?target=dummy&limit=50
     ```
   - **Via MongoDB Compass**:
     Open Compass &rarr; Connect &rarr; Click `dummy_data_db` &rarr; Click `dummy_footprints`.

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/database/status` | Check active database & MongoDB Compass connection info |
| `GET` | `/api/geofences` | Retrieve all geofences |
| `POST` | `/api/geofences` | Create a new geofence |
| `GET` | `/api/geofences/<id>` | Get details of a single geofence |
| `PUT` | `/api/geofences/<id>` | Update an existing geofence |
| `DELETE` | `/api/geofences/<id>` | Delete a geofence |
| `POST` | `/api/geofences/sample` | Seed and restore default sample geofences in MongoDB |
| `GET` | `/api/footprints` | Retrieve recent footprints (`?target=all\|simulation\|dummy&limit=50`) |
| `POST` | `/api/footprints` | Record a footprint or mouse boundary event |
| `DELETE` | `/api/footprints` | Clear footprint collections in MongoDB and reset log UI |
| `POST` | `/api/simulation/generate` | Generate and store dummy `ENTER`/`INSIDE`/`EXIT` records in `dummy_data_db` |
| `POST` | `/api/telemetry/evaluate` | Evaluate GPS coordinates against fences |

### Fetch Footprints Examples

- **Fetch Live Simulation & Mouse Data Only**:
  ```
  GET /api/footprints?target=simulation&limit=40
  ```
- **Fetch Dummy Test Data Only**:
  ```
  GET /api/footprints?target=dummy&limit=50
  ```
- **Fetch All Records (Merged)**:
  ```
  GET /api/footprints?target=all&limit=50
  ```

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
