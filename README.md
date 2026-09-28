# Virtual Fence - Interactive Geofence Map Builder

A modern, high-performance geofence management system and map builder with an interactive web dashboard and a lightweight Python backend.

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
- **Persistent Storage**:
  - Exclusively powered by MongoDB Atlas & MongoDB Compass across two dedicated databases: `simulation_data_db` and `dummy_data_db`. No SQLite.
- **Zero-Dependency Python Backend**:
  - Dual-engine architecture: Runs with **Flask** if installed, or falls back automatically to Python's built-in `http.server` with standard libraries.
- **Real-Time Telemetry API**:
  - REST API endpoint to evaluate GPS coordinates against all active geofences in real-time.

---

## Project Structure

```
virtualfence/
├── css/
│   └── style.css            # Custom CSS styling (dark/light UI, responsive layout)
├── js/
│   └── bundle.js            # Frontend map engine, drawing handlers, and state store
├── vendor/
│   ├── leaflet.css          # Leaflet CSS library
│   └── leaflet.js           # Leaflet JavaScript library
├── index.html               # Main dashboard UI
├── server.py                # Python backend (REST API, Telemetry Engine, SQLite)
├── requirements.txt         # Optional Python dependencies (Flask)
├── .gitignore               # Git ignore rules for venv, cache, and db
└── README.md                # Project documentation
```

---

## Getting Started

### Prerequisites

- **Python 3.8+** installed on your system.
- Modern web browser (Chrome, Firefox, Edge, Safari).

### 1. Clone the Repository

```bash
git clone https://github.com/Nitinbisht21/virtual_fence.git
cd virtual_fence
```

### 2. (Optional) Set Up Virtual Environment

The server runs out-of-the-box using Python's standard library. If you prefer running with Flask:

```bash
# Create virtual environment
python -m venv venv

# Activate on Windows:
.\venv\Scripts\activate

# Activate on macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Start the Server

```bash
python server.py
```

The server will launch at:
```
http://localhost:5000
```

Open `http://localhost:5000` in your browser to access the Geofence Map Builder dashboard.

---

---

## MongoDB & MongoDB Compass Integration

The application exclusively uses **MongoDB** as its persistent database engine, allowing you to visually inspect, manage, and query your geofences, sample perimeters, and live footprints using **MongoDB Compass** or **MongoDB Atlas**.

### Dedicated Databases & Collections:
1. **`simulation_data_db`**:
   - **`geofences`**: Contains all created shapes (Circle, Rectangle, Custom Polygon), sample perimeters, boundary coordinates, colors, and configuration.
   - **`simulation_footprints`**: Contains real-time telemetry footprints, live simulation loop data points, and boundary `ENTER` / `EXIT` events.
2. **`dummy_data_db`**:
   - **`dummy_footprints`**: Contains generated dummy area footprints strictly bounded inside active geofences.

### Connecting with MongoDB Compass:
1. Open **MongoDB Compass**.
2. In the connection string field, paste your Atlas connection string from `.env`:
   ```
   mongodb+srv://Nitin:fence@cluster0.7ulskib.mongodb.net/?retryWrites=true&w=majority
   ```
3. Click **Connect**.
4. Both databases (`simulation_data_db` and `dummy_data_db`) and their collections are immediately visible.

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
| `GET` | `/api/footprints` | Retrieve recent telemetry and flag footprint logs |
| `POST` | `/api/footprints` | Record a footprint or mouse boundary event |
| `DELETE` | `/api/footprints` | Clear all footprint records and reset log |
| `POST` | `/api/simulation/generate` | Generate dummy points strictly inside active fence areas |
| `POST` | `/api/telemetry/evaluate` | Evaluate GPS coordinates against fences |

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
