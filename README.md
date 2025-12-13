# **Senzor Core**

The robust, secure, and high-performance API core for the **Senzor** VPS Monitoring platform. Built with **Node.js, Express, and TypeScript**, it handles user authentication, agent telemetry ingestion, and data persistence with **MongoDB**.

## **🚀 Key Features**

- **Secure Authentication:** 
  - **Users:** Firebase Admin SDK (JWT verification).
  - **Agents:** Custom API Key & VPS ID headers.
- **High-Performance Ingestion:** "Fire-and-forget" telemetry endpoint optimized for high throughput.
- **Auto-Pruning:** Automatic deletion of telemetry data older than 24 hours via MongoDB TTL indexes to manage storage costs.
- **Validation:** Strict runtime payload validation using **Zod**.
- **Security Hardening:** Implements helmet, cors, and aggressive rate-limiting to prevent abuse.

## **🛠 Tech Stack**

- **Runtime:** Node.js (v18+)
- **Language:** TypeScript
- **Framework:** Express.js
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
MONGO_URI=mongodb://root:password@localhost:27017/sys-sentinel?authSource=admin

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

### **1. Management API (Requires Firebase User Token)**

_Headers:_ Authorization: Bearer \<firebase_id_token\>

| Method | Endpoint           | Description                                                 |
| :----- | :----------------- | :---------------------------------------------------------- |
| POST   | /api/vps/register  | Link a new VPS to your account. Returns the secret API Key. |
| GET    | /api/vps/list      | List all your registered VPS instances.                     |
| GET    | /api/vps/:id/stats | Get metadata and historical stats for a specific VPS.       |
| DELETE | /api/vps/:id       | Remove a VPS and its data.                                  |

### **2. Ingestion API (Requires Agent Credentials)**

_Headers:_ x-vps-id: \<id\>, x-api-key: \<key\>

| Method | Endpoint          | Description                             |
| :----- | :---------------- | :-------------------------------------- |
| POST   | /api/ingest/stats | Receives telemetry JSON from the Agent. |


## **🛡 Security Notes**

1. **API Keys:** Generated using crypto-secure random bytes. In strict compliance environments, these should be hashed in the DB (like passwords). Currently stored as plain text to allow user viewing (optional).
2. **Rate Limiting:**
   - **Management:** 100 req / 15 min.
   - **Ingestion:** 60 req / 1 min per IP (Allows 1 update/sec).

## **🧪 Testing Database Connection**

If you encounter AuthenticationFailed errors, use the provided test script:
```
# Edit the URI inside test-db.js first  
node ./test/db.js
```

## Coolify Deployment fix
1. Make the env of coolify shift from VARCHAR(255) to TEXT
```
docker exec -it coolify-db psql -U coolify -d coolify
ALTER TABLE environment_variables ALTER COLUMN value TYPE text;
```
2. Use chunked env as being done in this repo