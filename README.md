# CSPC-ICTU · Server Environment Monitoring & Control System

## Project Structure

```
cspc-ictu/
├── backend/                              ← Node.js + Express.js API Server
│   ├── collectors/
│   │   ├── sensor.collector.js           ← DHT11 sensor data ingestion (ESP32)
│   │   └── snmp.collector.js             ← SNMP metrics collector for servers
│   ├── config/
│   │   ├── env.js                        ← Environment variable loader
│   │   ├── influx.js                     ← InfluxDB client configuration
│   │   ├── mysql.js                      ← MySQL2 connection pool
│   │   └── socket.js                     ← Socket.IO instance export
│   ├── data/
│   │   └── db.js                         ← Shared in-memory fallback / seed data
│   ├── handlers/
│   │   ├── querySensorHistoryHandler.js  ← InfluxDB range query handler
│   │   └── sensorHandler.js              ← Live sensor data socket handler
│   ├── jobs/
│   │   ├── alert.job.js                  ← Polling job: evaluates alert rules
│   │   └── metrics.job.js                ← Polling job: collects server metrics
│   ├── middleware/
│   │   ├── auth.js                       ← JWT authentication + requireRole guard
│   │   ├── error.middleware.js           ← Global error handler
│   │   └── logger.middleware.js          ← Request logger (audit trail)
│   ├── models/
│   │   ├── alert.model.js                ← MySQL queries for alerts + alert_rules
│   │   ├── report.model.js               ← MySQL queries for reports
│   │   ├── server.model.js               ← MySQL queries for devices + server_specs
│   │   └── user.model.js                 ← MySQL queries for users
│   ├── routes/
│   │   ├── auth.js                       ← POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout
│   │   ├── aircon.js                     ← GET/POST /api/aircon (state, toggle, mode, temp)
│   │   ├── alerts.js                     ← GET /api/alerts, PATCH /api/alerts/:id
│   │   ├── environment.js                ← GET /api/environment/live|history|logs
│   │   ├── reports.js                    ← GET/POST /api/reports
│   │   ├── servers.js                    ← GET /api/servers, GET /api/servers/:id
│   │   └── users.js                      ← Full CRUD /api/users + /api/users/me (self-service)
│   ├── services/
│   │   ├── authService.js                ← Login logic, JWT sign/verify, password hashing
│   │   ├── permissionService.js          ← Role-based permission queries
│   │   └── userService.js                ← User CRUD business logic
│   ├── sockets/
│   │   └── connectionHandler.js          ← Socket.IO event handlers (live metrics, sensor, aircon)
│   ├── utils/
│   │   ├── asyncHandler.js               ← Async route wrapper (no try-catch boilerplate)
│   │   ├── helpers.js                    ← Shared utility functions
│   │   └── thresholds.js                 ← Alert threshold constants
│   ├── hash.js                           ← CLI utility: bcrypt hash generator
│   ├── server.js                         ← Express + Socket.IO entry point
│   └── package.json
│
└── frontend/                             ← React 18 + TypeScript + Vite + Tailwind CSS
    ├── src/
    │   ├── api/
    │   │   └── api.ts                    ← Central Axios API client (all HTTP calls)
    │   ├── context/
    │   │   ├── AuthContext.tsx           ← Auth state, login/logout, updateUser (session sync)
    │   │   └── ThemeContext.tsx          ← Dark/light mode toggle
    │   ├── data/
    │   │   └── users.ts                  ← roleConfig (role labels, colors, allowed pages)
    │   ├── components/
    │   │   └── layout/
    │   │       ├── Sidebar.tsx           ← Role-filtered navigation + avatar (opens ProfileModal)
    │   │       ├── Header.tsx            ← Top bar, live clock, avatar (opens ProfileModal)
    │   │       └── ProfileModal.tsx      ← Self-service profile editor (name, email, photo, password)
    │   ├── pages/
    │   │   ├── auth/
    │   │   │   ├── Login.tsx             ← Login page
    │   │   │   └── Unauthorized.tsx      ← 403 access denied page
    │   │   ├── Dashboard.tsx             ← Live overview: KPIs, env chart, alerts, server table
    │   │   ├── ServerMetrics.tsx         ← Live server CPU/memory/disk with expand drawer
    │   │   ├── ServerDetail.tsx          ← Per-server gauges, charts, specs
    │   │   ├── Environment.tsx           ← Temp/humidity charts with range picker
    │   │   ├── AirConditioner.tsx        ← AC unit monitoring with gauges + activity log
    │   │   ├── History.tsx               ← Grafana-style log panel + volume histogram
    │   │   ├── Reports.tsx               ← Report list + generate report
    │   │   ├── Settings.tsx              ← System settings (thresholds, server config)
    │   │   └── UserManagement.tsx        ← Full user CRUD (Admin only)
    │   ├── socket/
    │   │   └── socket.ts                 ← Socket.IO client instance
    │   ├── chart/
    │   │   └── ChartConfig.ts            ← Shared Chart.js defaults
    │   ├── App.tsx                       ← Route definitions + ProtectedRoute
    │   ├── main.tsx                      ← React entry point
    │   └── index.css                     ← Tailwind base imports
    └── package.json
```

## Setup & Run
Prerequisites

Node.js 18+
MySQL 8.0+
InfluxDB 2.x
ESP32 + DHT11 sensor (for live environmental data)

### Backend (Terminal 1)
```bash
cd backend
npm install
node server.js  
# → http://localhost:3000
```

### Frontend (Terminal 2)
```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

## API Endpoints

### Authentication

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|-----------|-------------|
| POST | `/api/auth/login` | ❌ | Public | Login and return JWT token |
| GET | `/api/auth/me` | ✅ | All | Get current authenticated user from token |
| POST | `/api/auth/logout` | ✅ | All | Logout and clear session |

### Users

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|----------------|-------------|
| GET | `/api/users` | ✅ | Admin | List all users |
| POST | `/api/users` | ✅ | Admin | Create a new user |
| PATCH | `/api/users/:id` | ✅ | Admin | Update user information (role, status, profile) |
| PATCH | `/api/users/:id/status` | ✅ | Admin | Enable or disable a user account |
| PATCH | `/api/users/:id/password` | ✅ | Admin | Reset any user's password |
| DELETE | `/api/users/:id` | ✅ | Admin | Delete a user account |
| PATCH | `/api/users/me` | ✅ | All | Update own profile |
| PATCH | `/api/users/me/password` | ✅ | All | Change own password |

### Servers

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|------|-------------|
| GET | `/api/servers` | ✅ | All | List all devices with live metrics |
| GET | `/api/servers/:id` | ✅ | All | Get detailed server information and specifications |

### Environment

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|------|-------------|
| GET | `/api/environment/live` | ✅ | All | Get latest temperature and humidity readings |
| GET | `/api/environment/history` | ✅ | All | Retrieve historical sensor data from InfluxDB |
| GET | `/api/environment/logs` | ✅ | All | View daily aggregated environment logs |

### Air Conditioner

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|-----------------|-------------|
| GET | `/api/aircon` | ✅ | All | Get air conditioner state and logs |
| POST | `/api/aircon/toggle` | ✅ | Admin, IT Staff | Toggle air conditioner ON/OFF |

### Alerts

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|------|-------------|
| GET | `/api/alerts` | ✅ | All | List system alerts with filters |
| PATCH | `/api/alerts/:id` | ✅ | All | Acknowledge or resolve an alert |

### Reports

| Method | Endpoint | Auth | Role | Description |
|----------|-----------|------|-----------------|-------------|
| GET | `/api/reports` | ✅ | All | List all generated reports |
| POST | `/api/reports` | ✅ | Admin, IT Staff | Generate a new report |


## Role Access Matrix

| Page | Admin | IT Staff |
|-------|--------|-----------|
| Dashboard | ✅ | ✅ |
| Server Metrics | ✅ | ✅ |
| Server Detail | ✅ | ✅ |
| Environment | ✅ | ✅ |
| Air Conditioner | ✅ | ✅ |
| History & Logs | ✅ | ✅ |
| Reports | ✅ | ✅ |
| Settings | ✅ | ❌ |
| User Management | ✅ | ❌ |

## Demo Credentials

| Role        | Username    | Password   |
|-------------|-------------|------------|
| Admin       | admin       | ictuadmin123   |
| IT Staff    | mikejay123  | akosimike   |
| IT Staff    | markgregorio| markgregorio   |

## Tech Stack

| Layer       | Technology                                      |
|-------------|-------------------------------------------------|
| Frontend    | React 18 + Vite                                 |
| Styling     | Tailwind CSS v3                                 |
| Charts      | Chart.js + react-chartjs-2                      |
| Realtime    | Socket.IO (client + server)                     |
| Backend     | Node.js + Express.js                            |
| Auth        | JWT (jsonwebtoken) + bcryptjs                   |
| MySQL       | mysql2 — users, devices, alerts, reports, logs  |
| InfluxDB    | @influxdata/influxdb-client — time-series sensor data  |
| IoT Sensor  | ESP32 + DHT11 (temperature + humidity)          |
| Rate Limit  | express-rate-limit                              |
