# **Senzor Core**

The robust, secure, and high-performance API core for the **Senzor** VPS Monitoring platform. Built with **Node.js, Express, and TypeScript**, it handles user authentication, agent telemetry ingestion, real-time WebSockets, background workers, and data persistence with **MongoDB**.

## **🚀 Key Features**

- **Secure Authentication:**
  - **Users:** Firebase Admin SDK (JWT verification).
  - **Agents:** Custom API Key & VPS ID headers.
- **High-Performance Ingestion:** "Fire-and-forget" telemetry endpoint optimized for high throughput.
- **Global Uptime:** Integrated background workers for distributed heartbeat checks (HTTP/TCP).
- **Web Terminal:** Secure SSH-over-WebSocket relay for browser-based server management.
- **Secure Auth:** Firebase Admin SDK integration (JWT) with Role-Based Access Control (RBAC).
- **Auto-Pruning:** Automatic deletion of telemetry data older than 24 hours via MongoDB TTL indexes to manage storage costs.
- **Validation:** Strict runtime payload validation using **Zod**.
- **Security Hardening:** Implements helmet, cors, and aggressive rate-limiting to prevent abuse.

## **🛠 Tech Stack**

- **Runtime:** Node.js (v18+)
- **Language:** TypeScript
- **Framework:** Express.js
- **Real-time:** Socket.io
- **Database:** MongoDB (Mongoose ODM)
- **Auth:** Firebase Admin SDK
- **Validation:** Zod
- **Logging:** Winston

## **⚙️ Prerequisites**

Before starting, ensure you have:

1. **Node.js** (v18 or higher) & npm installed.
2. **MongoDB Database** (Local or Atlas) connection string.
3. **Firebase Project** with a Service Account JSON key.

## **📦 Installation**

1. **Clone the repository:**

```
  git clone https://github.com/Senzops/core
  cd core
```

2. **Install dependencies:**

```
 npm install
```

3. Configure Environment:  
   Create a `.env` file in the `src/config` directory:
   ```
   cp src/config/.env.example src/config/.env
   ```

## **🔐 Environment Variables**

You must configure the following variables in your `/src/config/.env` file:

```.env
# Server Config
PORT=5000
NODE_ENV=development

# Database Connection
# IMPORTANT: Append ?authSource=admin if using root auth
MONGO_URI=mongodb://root:password@localhost:27017/senzor?authSource=admin

# Demo User (firebaseUid)
# OPTIONAL: Add when demo access required
DEMO_USER_ID=senzor-demo-account

# Firebase Service Account (JSON String)
# Copy the entire content of your service-account.json into this single line
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"...","private_key":"..."}'
```

## **🏃‍♂️ Running the Server**

### **Development Mode**

Runs with `ts-node-dev` for hot-reloading and direct TypeScript execution.

```
npm run dev
```

### **Production Mode**

Compiles TypeScript to JavaScript (dist/) and runs the optimized build.

```
npm run build
npm start
```

## **📚 API Endpoints**

### **1. Server Management**

_Headers:_ Authorization: Bearer \<firebase_id_token\>

| Method | Endpoint           | Description                                               |
| :----- | :----------------- | :-------------------------------------------------------- |
| POST   | /api/vps/register  | Register a new VPS. Returns SERVER_ID & API_KEY.          |
| GET    | /api/vps/list      | List all servers with status summaries.                   |
| GET    | /api/vps/:id/stats | Get historical telemetry, docker stats, and integrations. |
| DELETE | /api/vps/:id       | Irreversibly delete a server and its data.                |

### **2. Web Analytics**

_Headers:_ Authorization: Bearer \<firebase_id_token\>

| Method | Endpoint           | Description                                      |
| :----- | :----------------- | :----------------------------------------------- |
| POST   | /api/web/register  | Register a website for tracking. Returns WEB_ID. |
| GET    | /api/web/list      | List tracked websites.                           |
| GET    | /api/web/:id/stats | Get views, visitors, heatmaps, and geo-data.     |

### **3. Uptime Monitor**

_Headers:_ Authorization: Bearer \<firebase_id_token\>

| Method | Endpoint              | Description                           |
| :----- | :-------------------- | :------------------------------------ |
| POST   | /api/uptime/register  | Create a new HTTP/TCP monitor.        |
| GET    | /api/uptime/list      | List all monitors.                    |
| GET    | /api/uptime/:id/stats | Get latency graphs and check history. |

### **4. Ingestion API (Public/Agent)**

_Rate Limited: 60-200 req/min_

| Method | Endpoint          | Auth Header | Description                             |
| :----- | :---------------- | :---------- | :-------------------------------------- |
| POST   | /api/ingest/stats | x-api-key   | Ingest Server Telemetry.                |
| POST   | /api/ingest/web   | Body webId  | Ingest Web Analytics (Pageviews/Pings). |
| WS     | /api/socket       | x-api-key   | Secure WebSocket for Web Terminal.      |

## **🛡 Security Notes**

1. **API Keys:** Generated using crypto-secure random bytes. In strict compliance environments, these should be hashed in the DB (like passwords). Currently stored as plain text to allow user viewing (optional).
2. **Rate Limiting:**
   - **Management:** 100 req / 15 min.
   - **Ingestion:** 60 req / 1 min per IP (Allows 1 update/sec).
3. **Terminal:** Access is protected by Firebase Auth on the client side and API Key validation on the agent side.

## **🧪 Testing Database Connection**

If you encounter AuthenticationFailed errors, use the provided test script:

```
# Edit the URI inside test-db.js first
node ./test/db.js
```

### **Coolify / Dokploy Fixes**

If deploying to PaaS platforms like Coolify that use PostgreSQL for their internal env storage, you might hit character limits for the Firebase JSON key.

1. Fix Env Var Limit:  
   Access your Coolify database container and run:  
   docker exec -it coolify-db psql -U coolify -d coolify  
   ALTER TABLE environment_variables ALTER COLUMN value TYPE text;

2. Use Base64:  
   Always prefer FIREBASE_SERVICE_ACCOUNT_BASE64 for Docker deployments to avoid JSON parsing issues with newlines.
