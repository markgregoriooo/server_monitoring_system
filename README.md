# CSPC-ICTU · Server Environment Monitoring & Control System

## Project Structure

```
cspc-ictu/
├── backend/                          ← Node.js + Express.js API Server
│   ├── data/
│   │   └── db.js                     ← In-memory simulated database (MySQL / InfluxDB)
│   ├── middleware/
│   │   └── auth.js                   ← JWT authentication middleware + role guard
│   ├── routes/
│   │   ├── auth.js                   ← POST /api/auth/login, GET /api/auth/me
│   │   ├── servers.js                ← GET /api/servers
│   │   ├── environment.js            ← GET /api/environment/live|history|logs
│   │   ├── aircon.js                 ← GET/POST /api/aircon
│   │   ├── users.js                  ← GET/POST/DELETE /api/users
│   │   ├── alerts.js                 ← GET /api/alerts
│   │   └── reports.js                ← GET/POST /api/reports
│   ├── server.js                     ← Main Express + Socket.IO server
│   └── package.json
│
└── frontend/                         ← React 18 + Vite + Tailwind CSS
    ├── src/
    │   ├── api.js                    ← Central API client (all fetch calls)
    │   ├── context/
    │   │   └── AuthContext.jsx       ← Login/logout state + JWT storage
    │   ├── data/
    │   │   └── users.js              ← Role config (pages each role can access)
    │   ├── components/
    │   │   ├── Sidebar.jsx           ← Role-aware navigation
    │   │   ├── Header.jsx            ← Top bar with user info
    │   │   └── StatusBadge.jsx
    │   ├── pages/
    │   │   ├── auth/
    │   │   │   ├── Login.jsx         ← Login page (calls POST /api/auth/login)
    │   │   │   └── Unauthorized.jsx  ← Access denied page
    │   │   ├── Dashboard.jsx         ← Live overview (Socket.IO)
    │   │   ├── ServerMetrics.jsx     ← Live server CPU/memory (Socket.IO)
    │   │   ├── Environment.jsx       ← Live temp/humidity charts (Socket.IO)
    │   │   ├── AirControl.jsx        ← AC control panel (REST API)
    │   │   ├── History.jsx           ← Daily logs (REST API)
    │   │   ├── Reports.jsx           ← Reports list (REST API)
    │   │   ├── Settings.jsx          ← App settings
    │   │   └── UserManagement.jsx    ← CRUD users (Super Admin only)
    │   ├── App.jsx
    │   ├── main.jsx
    │   └── index.css
    └── package.json
```

## Setup & Run

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

| Method | Endpoint                    | Auth | Role            |
|--------|-----------------------------|------|-----------------|
| POST   | /api/auth/login             | ❌   | Public          |
| GET    | /api/auth/me                | ✅   | All             |
| GET    | /api/servers                | ✅   | All             |
| GET    | /api/environment/live       | ✅   | All             |
| GET    | /api/environment/history    | ✅   | All             |
| GET    | /api/environment/logs       | ✅   | All             |
| GET    | /api/aircon                 | ✅   | All             |
| POST   | /api/aircon/toggle          | ✅   | Admin, IT Staff |
| POST   | /api/aircon/mode            | ✅   | Admin, IT Staff |
| POST   | /api/aircon/temp            | ✅   | Admin, IT Staff |
| GET    | /api/alerts                 | ✅   | All             |
| GET    | /api/reports                | ✅   | All             |
| POST   | /api/reports                | ✅   | Admin, IT Staff |
| GET    | /api/users                  | ✅   | Super Admin     |
| POST   | /api/users                  | ✅   | Super Admin     |
| DELETE | /api/users/:id              | ✅   | Super Admin     |

## Role Access Matrix

| Page            | Super Admin | IT Staff | Viewer |
|-----------------|-------------|----------|--------|
| Dashboard       | ✅          | ✅       | ✅     |
| Environment     | ✅          | ✅       | ✅     |
| History         | ✅          | ✅       | ✅     |
| Server Metrics  | ✅          | ✅       | ❌     |
| Air Control     | ✅          | ✅       | ❌     |
| Reports         | ✅          | ✅       | ❌     |
| Settings        | ✅          | ❌       | ❌     |
| User Management | ✅          | ❌       | ❌     |

## Demo Credentials

| Role        | Username    | Password   |
|-------------|-------------|------------|
| Super Admin | superadmin  | admin123   |
| IT Staff    | itstaff     | staff123   |
| Viewer      | viewer      | viewer123  |

## Tech Stack

| Layer       | Technology                                      |
|-------------|-------------------------------------------------|
| Frontend    | React 18 + Vite                                 |
| Styling     | Tailwind CSS v3                                 |
| Charts      | Chart.js + react-chartjs-2                      |
| Realtime    | Socket.IO (client + server)                     |
| Backend     | Node.js + Express.js                            |
| Auth        | JWT (jsonwebtoken) + bcryptjs                   |
| Databases   | MySQL (users/servers) · InfluxDB (sensor data)  |
| Sensor      | DHT11 via ESP32                                 |
